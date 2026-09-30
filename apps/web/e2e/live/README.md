# Live E2E runner - Valuescan money flows on SoDEX mainnet

`run.ts` drives the web app's **own** trading and funds code (`src/trading/*`: `sendUsdcDeposit`,
`enableTrading`, `transferFunds`, `placeOrder`/`cancelOrder`, `withdrawFunds`, `withdrawalProgress`, ...)
from Node, with a real wallet backed by a private key, against SoDEX **mainnet** (ValueChain, chain id
286623). A green run proves the UI's logic end to end: account creation by a first deposit, the trading
key, transfers, orders, and every way money leaves the account.

> **`live` mode moves real money.** It deposits, trades and withdraws with the wallet you fund. Run
> `plan` first, fund a **fresh** wallet with only what the plan asks for, and keep `maxSpendUsd` low.

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
| `--config <file>` | the run's config (`config.example.json` documents every field). Required for `live` |
| `--confirm <address>` | `live`: must equal the address `VS_E2E_KEY` controls |
| `--only a,b` | run only these steps (preflight always runs) |
| `--throwaway-key` | `plan` only: a random in-memory key instead of `VS_E2E_KEY` |
| `--registry-only` | `plan` only: read deposit addresses from the on-chain registry alone - does not ask the backend, which asks SoDEX to *issue* addresses for a wallet that has none |
| `--backend <origin>` | override `config.backend` |
| `--report-dir <dir>` | where the JSON report goes (default `e2e/live/reports/`) |

Exit codes: `0` done (plan: a live run would start), `1` a step or preflight failed, `2` refused to
start (config, key, gates, or plan problems - nothing was signed or sent), `130` interrupted.

Add to `.gitignore` (not done by the runner):

```
apps/web/e2e/live/reports/
apps/web/e2e/live/config.json
```

## Safety model

- **Plan is read-only, enforced three times**: the network guard (`guard.ts`) refuses every non-read
  request (SoDEX writes, the relayer's `call_for_permit`/`analyse_address`, the backend's POSTs, any
  `eth_sendRawTransaction`); the wallet has no signing policy; the app's trading config is
  `writesAllowed: false, disabled: true`.
- **Live needs every gate**: `--confirm` equal to the key's address, `"acknowledgeRealFunds": true`,
  the backend reporting mainnet with writes allowed, no blocking plan problems, and - by default - a
  **brand-new wallet** (no SoDEX account; `allowExistingAccount` to resume).
- **The key** comes only from `VS_E2E_KEY` (0x + 64 hex). It is removed from `process.env` at once,
  never printed or written; the wallet keeps it inside viem's account closure, scrubs it from every
  error, and the report is scrubbed again before it is written. Only the address is shown.
- **Only expected writes leave the process.** Each step arms the network guard with exactly the writes
  its app call makes - kind, count, and a check of the parsed body: account, coin, amount, symbol,
  quantity, price, reduce-only; a withdrawal permit is **decoded** (coin, chain, receiver, amount,
  memo) on either channel (SoDEX's relayer or the gateway). Anything else gets a definite refusal
  (HTTP 403 / JSON-RPC error - never "maybe sent"). Unknown hosts are refused.
- **The wallet signs only what the step expects** (`provider.ts` policy): the exact USDC transfer to
  the verified deposit address, the key registration for this account, the token permit + deposit
  command for this token and amount, the withdrawal permit for this coin/chain/receiver/amount. With
  no policy it refuses every signature (EIP-1193 code 4100).
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
  per step from priced balances (so price moves of held coins show up too).
- **Exact amounts**: every amount is a decimal string in the coin's decimals; all maths is bigint.
  Order prices and sizes are snapped to the market's tick/step; limit prices stay inside the market's
  price band.
- **Settle, then continue; stop at the first failure.** Each step waits for its funds to land. Any
  failure or timeout stops the run and prints **where every coin is** (Spot, Perps, ValueChain wallet,
  every EVM chain, open orders, positions, anything in flight) and how to recover it in the UI.

## What to fund (default config)

A **fresh** wallet (no SoDEX account), on **Arbitrum One**:

- **25 USDC** (native USDC `0xaf88...5831`) - the deposit
- **~0.0002 ETH** - gas for that one USDC transfer (the rest stays)

Nothing on ValueChain: the run buys a little SOSO on SoDEX for the one ValueChain transaction that
needs gas, and wallet -> Spot deposits are gasless. Optional: set `receivers.valuechain` to **another
address you control** to test `withdraw-valuechain-other` (1 USDC leaves this wallet). `plan` prints
the exact checklist with live gas prices and what the wallet already holds.

Where the money ends (default, no cleanup): ~4 USDC + 0.001 ETH back on Arbitrum; ~9 USDC and
~0.0006 ETH (leftover of the ETH buy) in Spot; ~3 USDC + ~4 SOSO in the ValueChain wallet. Set
`cleanup.enabled: true` to bring the USDC back to Arbitrum (one more 1 USDC fee).

## The steps

| Step | App code it runs | What moves | Verified by | Timeout |
|---|---|---|---|---|
| `preflight` (always) | `api.health`, `assetConfigs`, `usdcRoutes`, `sodexAccountId`, `balancesOf`, `api.depositOptions`, `symbolFor`, `withdrawQuote`, `maintenanceFor`, `receiverBlacklisted` | nothing | - | - |
| `deposit-external` | `sendUsdcDeposit` (switches chain, checks the token on-chain, ONE ERC-20 transfer) | `deposit.amount` USDC -> the wallet's own SoDEX deposit address | receipt; then account exists and Spot USDC +amount (-1 activation for a new account) | `depositMinutes` (30) |
| `enable-trading` | `enableTrading` (one `UserSignedAddAPIKeyAction` signature, both engines) | nothing | SoDEX lists the key on each engine | 3 min |
| `transfers` | `transferFunds` Spot->Perps, Perps->Spot | 2 USDC each way | balances +/- exactly | `settleSeconds` |
| `orders` | `placeOrder` / `cancelOrder` | spot: limit buy far below the bid -> open -> cancel -> gone; market buy of SOSO. perps: collateral in; limit -> cancel; market buy at the minimum size -> reduce-only market sell -> flat; collateral out | open orders, order history, balances, positions | `orderSeconds` |
| `spot-to-evm` | `transferFunds` Spot->EVM | 3 USDC; all SOSO (lands as native SOSO) | ValueChain wallet balances | `settleSeconds` |
| `evm-to-spot` | `transferFunds` EVM->Spot (`depositFromWallet`: token permit + CallForPermit, relayed, gasless) | 1 USDC | Spot | `settleSeconds` |
| `withdraw-valuechain-self` | `withdrawFunds` route `VALUECHAIN`, receiver = wallet, source Spot | 1 USDC | wallet USDC | `settleSeconds` |
| `withdraw-valuechain-other` | `withdrawFunds` route `VALUECHAIN`, receiver = `receivers.valuechain` (skipped if unset) | 1 USDC to your other address (engine -> own wallet -> ONE ERC-20 transfer) | the receiver's USDC | `settleSeconds` |
| `withdraw-external` | `withdrawQuote`, then `withdrawFunds` with `expectedFee` (as the Withdraw sheet); `withdrawalProgress` | 5 USDC -> Arbitrum, to the wallet itself (Spot -> wallet, SoDEX address check, ONE permit relayed by SoDEX) | SoDEX's on-chain withdrawal record final + success AND the Arbitrum balance +amount-fee | `withdrawMinutes` (30) |
| `extra-deposits` | as `deposit-external` (USDC only) | per entry | as above | as above |
| `extra-withdrawals` | as `withdraw-external`; `buyIfMissing` market-buys the missing coin on Spot first | per entry (default: 0.0015 ETH -> Arbitrum, native) | as above | as above |
| `cleanup` (opt-in) | `transferFunds`, `withdrawFunds` | Perps -> Spot, wallet USDC -> Spot, all Spot USDC -> the wallet on `cleanup.chain` | as above | as above |

Every step re-reads live state first (so `--only` can resume), records timings, tx hashes, amounts and
fees, and is refused before signing if its estimate would break `maxSpendUsd`.

## What it costs (default config, as of the plan run)

| Item | Cost |
|---|---|
| Account activation (first deposit) | 1 USDC |
| USDC withdrawal to Arbitrum | 1 USDC (on-chain fee; the plan reads it live) |
| ETH withdrawal to Arbitrum | 0.0005 ETH (~$1.35) |
| Trading (spot taker 0.065 % on ~$1.2 SOSO, perps taker 0.04 % x2 on ~$12, spreads) | ~$0.02 |
| Gas: Arbitrum USDC transfer | ~$0.01; ValueChain: negligible |
| Optional cleanup withdrawal | +1 USDC |
| **Total** | **~$3.4** (+$1 with cleanup) + anything sent to your other address |

The ETH buy (~5.6 USDC) is not a cost: the ETH is withdrawn to you (minus the fee) and the rest stays
in Spot.

## Coverage policy - one run per chain

The deposit/withdraw mechanism is **per chain**: all coins on one chain share the wallet's deposit
address and SoDEX's custody path there. So:

1. **One run per chain** you care about (Arbitrum is the default). For another EVM chain, change
   `deposit.chain`, `withdrawExternal.chain` and the `extraWithdrawals` entry, e.g. Base:
   `"deposit": { "chain": "BASE_ETH", "amount": "25" }`,
   `"withdrawExternal": { ..., "chain": "BASE_ETH" }`,
   `"extraWithdrawals": [{ "coin": "ETH", "chain": "BASE_ETH", "amount": "min", "receiver": "self", "buyIfMissing": true }]`
   (fund the wallet on Base instead). BNB Chain: native coin `BNB`; Polygon has no native-coin route.
2. **Withdrawals: both a token and the native coin** where the chain offers both (USDC **and** ETH on
   Arbitrum/Base/Ethereum, USDC and BNB on BNB Chain) - they pay out through different contracts.
3. `plan` prints the live **per-chain table**: USDC and the native coin per chain, deposit minimum,
   withdrawal minimum and fee, and whether the runner can deposit from / verify arrival on that chain.
   Chains the runner cannot read (Solana, Bitcoin, XRP, ...) can still be withdrawal targets via
   `receivers` (XRP/XLM need `"memo"` or `"noMemo": true`); arrival there is verified by SoDEX's
   on-chain withdrawal record only.

Deposits the runner makes are USDC through the app's `sendUsdcDeposit` (the only external deposit the
app itself sends); native coins go to the same shared address, so one USDC deposit covers the chain's
deposit path.

## Resuming

The trading key lives in memory, so every run registers a fresh one (one signature, no funds) when a
step needs it. To resume after a stop, fix the cause, then e.g.
`--only withdraw-external,extra-withdrawals` with `"allowExistingAccount": true`. Each step moves its
configured amount **again** when re-run - check the report's `steps` first.

## If it stops

The console and the report end with **where every coin is** and anything **in flight** (a deposit sent
but not credited, a withdrawal submitted but not final - with its tx hash). Recover in the app
(connect the same wallet):

- Perps -> Spot: Transfer sheet. Spot -> a wallet on any chain: Withdraw sheet.
- ValueChain wallet -> Spot: Deposit -> "Transfer from ValueChain".
- Open orders / positions: trade page tabs.
- A deposit in flight: SoDEX credits it when custody sees it - nothing to resend.
- A withdrawal in flight: its SoDEX record decides; a failed one paid from Spot returns to Spot. The
  app refuses to send a second permit while an unclear one may still execute.

## Reading the report

`e2e/live/reports/<ISO time>-<mode>.json`:

- `plan` - problems/warnings, funding checklist, per-chain route table, markets, deposit-address
  check, per-step plan lines and estimates.
- `steps[]` - per step: `status` (ok / failed / blocked / skipped), timings, `subSteps[]` (each check
  and action), `txs[]` (chain, hash, explorer, gas), `amounts`, `fees`, `measured` (priced value
  before/after, cost, sent away), `error`.
- `spend` - running totals against `maxSpendUsd`.
- `snapshots.start` / `.end`, `whereFunds`, `inFlight`.
- `network.requests` - every request (method, host, path, status, ms; write responses), and
  `network.refused` - anything the guard stopped. Request bodies are never stored.
- `appLog` - the app's own log ring buffer (`src/log.ts`, secrets redacted).

## Files and tests

| File | |
|---|---|
| `run.ts` | CLI entry: arguments, key, gates; loads `runner.ts` |
| `runner.ts` | configures the app's trading layer for Node, guard, wallet, preflight, steps, report |
| `provider.ts` | the key-backed EIP-1193 wallet |
| `guard.ts` | the fetch wrapper: relative URLs, known hosts, plan = read-only, live = expected writes |
| `plan.ts` | preflight / plan mode |
| `steps.ts` | the live steps |
| `reads.ts`, `context.ts`, `config.ts`, `util.ts` | reads/snapshots, step recorder, config validation, exact decimals |

Offline tests (no network, no keys that matter):

```
npx tsx --test e2e/live/provider.test.ts e2e/live/safety.test.ts e2e/live/simulate.test.ts
npx tsc --noEmit -p e2e/live
```

`simulate.test.ts` runs a **whole live run** against a stateful fake of the backend, the SoDEX gateway,
SoDEX's relayer and every chain's RPC - under the real guard, wallet and app code - and checks that no
write is refused, every verification converges and the money ends where the plan says
(`VS_SIM_VERBOSE=1` prints the transcript). It cannot prove that SoDEX behaves like the fake.

## Notes

- The trading key is registered under the app's name for desktop browsers, `valuescan-web`; SoDEX
  replaces a key of the same name, so a browser session of the **same wallet** loses its key (enable
  again there). The runner's key expires after `keyTtlHours` (24 h).
- `plan` (without `--registry-only`) asks the backend for the wallet's deposit options, which asks
  SoDEX to issue deposit addresses for it - the same as opening the app's Deposit sheet; no funds move.
- Custody withdrawals send the receiver address to SoDEX's address risk check (`analyse_address`),
  exactly as the app and sodex.com do.
- The runner follows `src/trading/funds.ts` as of 2026-09-26 (relayed permits, gasless wallet -> Spot).
  If those request shapes change, the guard refuses the new ones (nothing is sent) until the runner's
  expectations are updated - run the offline tests after any change there.
