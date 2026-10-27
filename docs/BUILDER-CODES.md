# Builder codes: the ValueDesk fee on SoDEX orders

Status: 2026-10-02. **Off until a builder is named** (`VITE_BUILDER_ID`); **once one is named, the
approval is required**: an order placed here goes out with the builder at the fee the wallet owes,
or not at all. Implemented and tested against a fake gateway that verifies every signature; **not
yet exercised against SoDEX with a real wallet** - no agent may sign or send a write. Section 9 is the
test the owner runs before switching it on; section 10 lists what that test settles.

How the fee is enforced, and how a wallet's fee follows the volume it traded here:
[BUILDER-TIERS.md](BUILDER-TIERS.md). This page is about builder codes themselves.

SoDEX's own description (the spec this follows):
<https://sodex.com/documentation/for-developers/developers/trading/builder-codes-in-trading>.
Signing rules: <https://sodex.com/documentation/for-developers/developers/trading/authentication-and-signing>
and <https://sodex.com/documentation/for-developers/developers/trading/authentication-and-signing/manual-rest-signing>.
Response shapes: <https://sodex.com/documentation/for-developers/api-reference/trading-api/rest-v1/schema>.

---

## 1. How it works

A **builder** is an ordinary SoDEX trading account that is paid a fee on the fills of orders that name
it. There is no registration: the builder id is the account's numeric id. Three things have to be true
for a fee to be charged.

1. **The builder is eligible.** Its account holds at least **100 vUSDC in Spot and 100 vUSDC in
   Perps**. SoDEX checks this when a user approves (or clears) a fee and, per its documentation, again
   when a fill is cleared.
2. **The user approved a maximum.** The user's *master wallet* (not a trading key) signs one EIP-712
   message that names the builder and a ceiling, `maxFeeRate`. The approval belongs to the **account**:
   it survives every trading-key rotation, applies to both engines, and stays until the user sets it
   to 0. A user can hold at most 10 approvals.
3. **The order names the builder.** Each order carries `"builder": {"id": <builder>, "fee": <rate>}`.
   SoDEX charges `fee` - the order's rate, not the approved ceiling - on each fill of that order and
   credits it to the builder. An order naming a builder the user has **not** approved (or a fee above
   the approval) is **rejected**.

**Units.** Every rate is a whole number in **tenths of a basis point**: `10` = 1 bp = 0.01 % of the
fill's notional, `50` = 0.05 %. `fee = notional * rate / 100 000`.

| | Perps | Spot |
|---|---|---|
| Highest fee an order may carry | 200 (0.2 %) | 2000 (2 %) |
| Which fills pay | every fill, buys and sells | **sells only** (the fee is taken in the quote asset; a buy pays its fee in the base coin, which builders do not receive) |
| Maker fills | pay it too | pay it too |
| Highest `maxFeeRate` a user can approve | 2000 for the account; the perps engine lists it as 200 | 2000 |

The last row matters: one approval of 500 is listed by SoDEX as *spot 500, perps 200*. An approval
therefore has to be read **per engine** - which is what the app does everywhere.

The fee is **on top of** SoDEX's own trading fee. A user at SoDEX's base tier selling on spot through a
builder charging 10 bp pays 6.5 + 10 = 16.5 bp as taker and 3.5 + 10 = 13.5 bp as maker (measured,
section 6).

---

## 2. What ValueDesk does

ValueDesk is non-custodial: orders are signed in the browser by a trading key and sent straight to
SoDEX. The builder fee adds nothing to that picture - no server sees an order, an approval or a fee.
Who is paid, the highest fee and the approval ceiling are fixed in the bundle the user loads
(build-time settings, section 3). The ValueDesk API can do exactly one thing: **lower** one wallet's
fee below the bundle's, with a statement signed by a key the bundle pins (section 2.7). It cannot
raise a fee, name another builder, or switch the fee off.

### 2.1 Enabling trading

With **no builder configured**, enabling trading is what it always was: one wallet signature that
registers the browser's trading key. None of the code below runs.

With a builder configured, `enableTrading` (`apps/web/src/trading/session.ts`) first **reads** the
account's approvals (`GET /api/v1/user/{owner}/builders`, public) and then:

| What SoDEX lists | What happens | Wallet signatures |
|---|---|---|
| An approval covering the configured fee on every engine that charges | Nothing is asked. The approval is recorded and the key is registered. This is the normal case from the second time on (key rotation, a new device, a cleared browser) | 1 (the key) |
| No approval, or one that is too low, or one engine only | The disclosure dialog opens (section 2.3). On **Approve**: the wallet signs `ApproveBuilderFeeAction` for `maxFeeRate = VITE_BUILDER_MAX_FEE`, the browser posts it to `POST /api/v1/user/{owner}/builders`, both engines are read again (six reads over about nine seconds, since reads lag a write), then the key is registered | 2 (approval, then key) |
| SoDEX cannot be reached for the read | Optional build: trading is enabled without the fee for now, and the approval is re-read later. Required build: enabling stops with a "check your connection" message; nothing is signed | 1 / 0 |

Rules the flow keeps, each of them covered by a test:

- **Nothing is signed without a yes.** If no disclosure can be shown, the answer is "decline".
- **The fee is attached only where SoDEX itself lists the approval**, per engine. What the wallet
  signed, what the gateway answered and what this browser remembers do not count - only the listing.
  That is also what makes "shown cost = charged cost" true: the fee lines in the UI use the same
  decision as the signed order (`quoteBuilderFee` -> `orderBuilder` in `trading/builder.ts`).
- **No answer is not a no.** If the approval request gets no response, the listing is read before
  anything else; a retry always starts with a read and takes a fresh nonce, so pressing Enable again
  is safe and never signs twice for nothing.
- **A lagging listing is followed up.** If SoDEX accepted the approval but does not list it on every
  engine yet, trading is enabled, the listing is re-read after 3, 10, 30 and 90 seconds, and again
  before an order is placed.
- **The listing stays the source of truth afterwards.** It is re-read whenever a stored key is
  restored (page load) and whenever SoDEX rejects an order with a message naming the builder. An
  approval revoked on another device stops being attached; one that appears starts being attached.

**A build that names a builder requires the approval.** That is the default and what every build
users see must be. `VITE_BUILDER_REQUIRED=0` makes the fee optional - a user who declines trades
without it - and exists for test builds only. The two differ in what a missing approval means:

| | Required (the default: `VITE_BUILDER_REQUIRED` unset or `1`) | Optional (`VITE_BUILDER_REQUIRED=0`, test builds) |
|---|---|---|
| User declines in the dialog | Trading stays off: "Trading through ValueDesk requires approving its builder fee, so trading stays off. Nothing was changed on your SoDEX account." No key is registered | Trading is enabled **without** the fee |
| User closes the dialog (Cancel, Escape) | The same message as declining | Nothing happens; trading stays as it was |
| Wallet rejects the approval signature | Trading stays off, same message | Trading is enabled without the fee; the reason is logged |
| SoDEX refuses the approval | Trading stays off; the message carries SoDEX's reason | Trading is enabled without the fee; SoDEX's reason is logged |
| Approved on one engine only | Trading is enabled; orders on the engine without the approval are refused with an explanation | The fee is attached on that engine, not on the other |
| An order when the approval is not listed | Refused before signing (after one re-read), with where to approve it (section 2.5). **No order leaves without the builder** | Sent without a builder |
| The approval is revoked or lowered on SoDEX later | SoDEX rejects the next order (it names a builder that is no longer approved); the app re-reads and sends nothing more until it is approved again | The next order is rejected once, then orders go out without the builder |

"Logged" means the app's logger, namespace `trade` (`apps/web/src/log.ts`): `log.warn('builder fee: the
approval did not go through', { builderId, maxFeeRate, reason, code, httpStatus })`. Open the page with
`?debug=trade` to see the whole flow, or run `__vs.dump()` in the console afterwards.

### 2.2 Orders

`placeOrder` (`trading/actions.ts`) is the only place an order is created. It attaches
`{id, fee}` as the **last field of the batch**, `id` before `fee` (the byte order SoDEX verifies),
when and only when the engine's listed approval covers that fee. `fee` is **the fee the wallet owes
now** (`feeNow` in `trading/terms.ts`): the build's `VITE_BUILDER_FEE_PERPS` / `_SPOT`, lowered only
by terms the server signed for that wallet (section 2.7). A build fee of 0 on an engine attaches
nothing there.

**The gate.** Every action the trading key signs passes one check first (`guardAction` in
`trading/feeGuard.ts`, called by `signAndSend`, the only place the app signs an exchange action).
It does not build anything: it looks at the finished action and refuses what must not leave - an
order without the builder in a build that requires it, a fee below the fee owed or above the
default, another builder, a leg with a builder of its own, a TWAP order (SoDEX's TWAP request cannot
carry a builder), an action type it does not know. Refused means not signed and not sent. The rules
in full: BUILDER-TIERS.md section 2.

- **Every order the user places carries it**: the order ticket, the take-profit and stop-loss legs
  placed with an order (same batch, same builder), and the orders the positions table places - "Close
  position" (a reduce-only market order) and a take-profit or stop-loss added there. On perps the fee
  is charged on both sides, so closing pays it too; the disclosure says "buys and sells". Exempting
  reduce-only orders would be a product decision and a three-line change in `builderForOrder`.
- Spot **buys** carry the builder too (the field is per batch, not per side) and are charged nothing -
  the same as every other builder on SoDEX (section 6).
- Cancels, leverage, margin, transfers and withdrawals have no builder field and are unchanged.
- **Take-profit and stop-loss orders** say what they are (`modifier`, SoDEX "Place multiple orders"):
  an entry with its own exits is `BRACKET` (never reduce-only) and each exit `ATTACHED_STOP`
  (reduce-only) - one batch, one builder; a take-profit / stop-loss on a position is `STOP` and
  reduce-only; a stand-alone trigger order is `STOP` and not reduce-only; everything else `NORMAL`.
  Triggers fire on the mark price: SoDEX does not accept last or index price in order placement
  yet, so the ticket offers Mark only and the app refuses the others before signing. All three
  shapes are byte-identical to the official Go SDK's (vectors `perps_bracket_tp_sl`,
  `perps_position_tp`, `perps_standalone_stop`).
- **Editing** a resting order goes through one function, `changeOrder(engine, ref, change)` in
  `trading/actions.ts` - the open orders' Modify, the positions table's take-profit / stop-loss
  edit and the chart drag all call it. It reads the order from SoDEX and picks the request SoDEX
  has for it: a take-profit / stop-loss -> SoDEX's **modify** request (SoDEX: "the order must be a
  TP/SL order"); a plain limit order, good-till-cancelled or post-only, new or partly filled ->
  SoDEX's **replace** request (spot and perps), sending only the fields that change; anything else
  is refused before signing. SoDEX's modify and replace requests have no builder field, and
  whether the changed order keeps the original's builder is not documented. Two constants in
  `trading/feeGuard.ts` say what is assumed until the live test has looked (section 9, step 9):
  `MODIFY_KEEPS_BUILDER = true` (the order is changed in place, same id - the request is used) and
  `REPLACE_KEEPS_BUILDER = false` (a new order is created - in a build that requires the builder the
  change is made as **cancel + new order with the builder** instead, `recreateOrder` in
  `trading/actions.ts`). That is two requests and not atomic, so everything that can be known
  beforehand is settled before the cancel (the order is read from SoDEX and rebuilt, validated, its
  builder decided); an order that cannot be rebuilt exactly is refused and left as it is. If SoDEX
  still refuses the new order, the error says in plain words that the original is gone. A size
  given for the change is the order's new TOTAL: the new order is for that total minus what has
  already filled.
- **TWAP** orders are not offered and are refused by the gate in a build that requires the builder.

### 2.3 What the user sees

**Builder OFF (no `VITE_BUILDER_ID`).** Exactly what the app showed before this change: no dialog, no
fee line, no extra sentence, the same toasts. The key options dialog ("Advanced key options") still
shows the row *Builder fee approved: none*, as it did.

**Builder ON.**

- *Enable trading* (first time for this account): a small dialog, **"ValueDesk builder fee"**, before
  any wallet prompt. It states, with the build's own numbers:
  - Perps orders: x % of each fill, buys and sells
  - Spot sells: y % of each fill
  - Spot buys: no builder fee
  - Maximum you approve: z % of a fill
  - Paid to: ValueDesk, SoDEX builder account #id
  - that SoDEX charges it on each fill on top of its own trading fee, maker and taker alike; that
    ValueDesk cannot charge more than the maximum without a new signature; that it can be revoked at
    any time (and where); and whether it is optional or required.

  Buttons: **Cancel**, **Enable without the fee** (optional builds only) and **Approve and enable
  trading**. A click on the backdrop does not close it - a fee is agreed to on purpose. (Opened from
  the key options instead - section 2.5 - trading is not being enabled, so the same dialog has two
  buttons, **Cancel** and **Approve the fee**, and its last sentence says what not approving means
  there.) Then two toasts announce the two wallet prompts ("Approve the builder fee in <wallet> - the
  first of two signatures."), and the result: "Trading enabled. Orders placed here carry the ValueDesk
  builder fee you approved." or "Trading enabled, without the ValueDesk builder fee."
- *Enable trading* (account already approved): one wallet prompt, as without a builder.
- *Order ticket*: under the venue's **Fees** line a line of its own, **ValueDesk fee** `builder`,
  `+0.0500%` (or "none on spot buys"), with a tooltip saying who is paid. The order review adds **Est.
  ValueDesk fee** with the amount for this order. Both exist only while the order will really carry
  the fee (or, in a required build, always - every order that leaves will carry it). Like the Fees
  label above it, the label is pressable: it opens the key options. The rate shown is the fee the
  order will carry. When the wallet is on a lower volume tier the default is shown struck through
  beside it (`+0.0200%` ~~struck~~ `+0.0150%`, the ticket's own look for a discounted venue rate), and
  when the terms name a next tier one small line under it says so: "ValueDesk fee 0.0150% once
  $10.00 is traded through ValueDesk ($4.20 so far)."
- *Fee tier panel*: a **ValueDesk fee** figure next to the venue's taker and maker rates, one sentence
  explaining it, and a "See or revoke your approval" link to the key options ("Approve it, or see what
  is approved" while a required build's fee is not approved yet). Never mixed into the venue's rates.
  A lower tier and the next tier are said in the same sentence.
- *Key options* ("Advanced key options"): **Builder fee approved** shows what SoDEX lists per engine
  ("perps up to 0.05%, spot up to 0.05% of a fill, builder account 12345"), with **Revoke builder
  approval** while there is one, and **Approve builder fee** while SoDEX lists no approval that
  covers what the build charges.
- *Trade history*: the Fee column and totals are unchanged and correct - SoDEX's `fee` already
  includes the builder's part (section 6).

### 2.4 Revoking

Order ticket -> press **ValueDesk fee** -> **Revoke builder approval** (in the key options that open):
one wallet signature for the same message with `maxFeeRate: 0`. The app reads first (nothing to revoke
-> nothing to sign), sends, then reads both engines until the builder is gone from both lists, and
stops attaching the fee. In a required build revoking also turns trading off on this device, since the
key is of no use here without the approval. The dialog revokes with trading off too (the approval is
the account's, not the key's).

SoDEX checks the *builder's* balance even for a revocation: if the builder account is below its
minimum, users cannot clear their approval until it is topped up. Keep it funded (section 4).

### 2.5 Approving later

The approval does not have to happen while enabling trading. `approveBuilderFee`
(`trading/session.ts`) does the same thing on its own: read what SoDEX lists, show the same disclosure
(told that it is asked on its own: `terms.purpose === 'approve'`, buttons **Cancel** and **Approve the
fee**), ONE signature for the maximum, send, read again - and nothing else (no key is registered). The
key options offer it as **Approve builder fee** whenever SoDEX's own answer says the account's
approval does not cover what the build charges. It is for:

- a **required** build and a browser that still holds a trading key from before the build had a
  builder: its orders are refused ("... press "ValueDesk fee" in the order ticket and approve it
  there"), the ticket's fee line opens the key options, one signature later the orders go out;
- an approval on one engine only, or below a fee that was raised since;
- an account that enabled trading without the fee and wants it after all.

Like the revocation it works with trading off, and a key enabled afterwards finds the approval.

### 2.6 Where the key options open from

The dialog used to be reached from the address menu ("Advanced…") and the Money page; neither exists
in today's interface, so in a build without a builder nothing opens it. With a builder, the two fee
lines above do. Two consequences worth knowing:

- In a build as it ships (required) the ticket's fee line is always there, so the key options are
  always one press away.
- In an optional build the ticket's fee line exists only while the fee is attached, i.e. with trading
  on and the approval listed. A user who approved, then turned trading off, enables trading again
  first (one signature, no dialog - the approval is there) and finds the line back. A user who
  enabled *without* the fee has no line to press: they are asked again the next time they enable
  trading (a key lasts 7 days at most).
- A permanent entry - a "Key options" row in the address menu - would be better, and is one line
  (`requestAdvanced` from `components/account/actions.ts`). The address menu follows the owner's
  reference design and belongs to another change, so it was not added here.

### 2.7 The fee a wallet owes, and the signed terms

The fee an order carries is the build's default unless ValueDesk's server has **signed** a lower one
for that wallet (`trading/terms.ts`; the contract is BUILDER-TIERS.md section 3):

- The app asks its own API (`GET /api/vs/builder/terms?address=...&nonce=...`, never SoDEX) when
  trading is enabled or restored, every four minutes while it is on, and a few seconds after a fill
  (`hint=1`, at most once a minute), so a new tier arrives without a reload.
- It rebuilds the signed message from the values it is about to use - the chain it trades on, the
  pinned builder, the connected wallet, the nonce it just sent, the two fees - and verifies the
  Ed25519 signature with WebCrypto under a key pinned in the bundle (`VITE_BUILDER_TERMS_KEYS`).
- Verified terms hold for their `ttl`, at most 15 minutes, counted on the monotonic clock, and live in
  memory only. Then, or after a reload, the fee is the default until new terms verify.
- **Whatever goes wrong ends in the default (highest) fee**: the request blocked, the answer
  rewritten or replayed, signed by another key, for another wallet, builder or chain, expired, a
  browser without Ed25519, a build without pinned keys. Nothing in storage, the address bar or the
  console feeds the fee.
- Without `VITE_BUILDER_TERMS_KEYS` no terms are ever asked for: every wallet pays the build's fees,
  exactly as before the tiers existed.

---

## 3. Configuration

Build-time variables of the web app (`apps/web/.env.local`, documented in
`apps/web/.env.local.example`). They are read by Vite at build time: a change needs a restart of
`npm run dev` or a new build.

| Variable | Meaning | Values |
|---|---|---|
| `VITE_BUILDER_ID` | The builder account id. **Unset = no builder: nothing is approved, attached or shown. Set = the approval is required** | positive integer |
| `VITE_BUILDER_FEE_PERPS` | The default (highest) fee on every perps fill of an order placed here | 0..200, default 0 |
| `VITE_BUILDER_FEE_SPOT` | The default (highest) fee on every spot **sell** fill of an order placed here | 0..2000, default 0 |
| `VITE_BUILDER_MAX_FEE` | The ceiling the wallet approves | 0..2000, default: the higher of the two fees |
| `VITE_BUILDER_TERMS_KEYS` | Public keys of the server that may lower a wallet's fee (section 2.7). Unset = every wallet pays the two fees above | Ed25519, base64url of the raw 32 bytes, comma separated |
| `VITE_BUILDER_REQUIRED` | Leave unset. `0` = the fee is optional (a user who declines trades without it) - test builds only | unset / `1` (required), or `0` |

Example - 2 bp on perps and on spot sells, with volume tiers:

```
VITE_BUILDER_ID=12345
VITE_BUILDER_FEE_PERPS=20
VITE_BUILDER_FEE_SPOT=20
VITE_BUILDER_MAX_FEE=20
VITE_BUILDER_TERMS_KEYS=<the public key `npx tsx tools/builderTiers.ts init` printed in apps/server>
```

How the values are treated (`apps/web/src/trading/config.ts`):

- **A build that names a builder and cannot charge it does not trade for free.** A value that is
  present but unusable (not a whole number, out of range, a maximum below a fee, a
  `VITE_BUILDER_REQUIRED` that is neither `0` nor `1`), or a builder id with both fees 0, switches
  **trading off in that build** and logs `TRADING IS OFF in this build: it names a builder but its fee
  settings are invalid` with the list of problems. A typo never becomes "0", never signs something
  unintended, and never drops the fee silently. (Only with `VITE_BUILDER_REQUIRED=0` does such a
  build behave as before: the builder is simply off.)
- An unusable entry in `VITE_BUILDER_TERMS_KEYS` is dropped and named in the log. It can only cost a
  discount - with no usable key every wallet pays the default - never the fee.
- The builder id, the default fees and the ceiling are not configurable at run time and not by the
  server: `/api/health` can switch trading off, it cannot name a builder or a rate. The one thing the
  server can do is sign a **lower** fee for a wallet (section 2.7), between 0 and the default here.

Things to know before changing them later:

- **Raising a fee above what users approved** stops the fee for those users (optional build) or stops
  their orders with an explanation (required build) until they approve the new maximum - asked for
  the next time they enable trading, or at once from the key options (section 2.5). Set
  `VITE_BUILDER_MAX_FEE` only as high as you intend to charge - the dialog shows it,
  and a high ceiling is a reason to decline.
- **Lowering a fee** needs nothing: existing approvals cover it.
- **Changing `VITE_BUILDER_ID`** leaves the old approvals on users' accounts (harmless, but each uses
  one of their 10 slots) and the app then only offers to revoke the new builder. Avoid it.
- **Kill switch:** remove `VITE_BUILDER_ID` (and the other `VITE_BUILDER_*` lines) and rebuild. No
  order names the builder any more; approvals stay on the accounts and cost nothing.
- **Tiers off, fee on:** remove `VITE_BUILDER_TERMS_KEYS` (or the server's tiers file). Every wallet
  pays the default fee; nothing else changes.

The same settings for the live end-to-end runner are the `builder` block of
`apps/web/e2e/live/config.json` (see `apps/web/e2e/live/README.md`).

---

## 4. Becoming a builder

1. Pick the wallet whose SoDEX account receives the fees. Use a **dedicated** account that does not
   trade: then every change of its balance is fee income (section 6).
2. Activate the account (a first deposit opens it) and hold **at least 100 vUSDC in Spot and 100 vUSDC
   in Perps** - deposit, then Transfer between the two. Keep a margin above 100: if either engine drops
   below the minimum, new approvals **and revocations** fail, and SoDEX documents that the minimum is
   checked again when fills are cleared.
3. Check it and get the settings:

   ```
   node apps/web/tools/check-builder.mjs <builder wallet address> [--testnet]
        [--fee-perps <n>] [--fee-spot <n>] [--max <n>] [--required] [--json]
   ```

   Read-only: three GET requests to SoDEX's public gateway, no wallet, no key. It prints the builder id
   (`GET /api/v1/user/{address}/subaccounts` -> `primaryAccountID`), the vUSDC each engine holds and
   whether that is enough, and the exact `VITE_BUILDER_*` lines. Exit code 0 = eligible, 1 = not
   eligible or no account, 2 = usage or network error - usable as a monitor.

   ```
   SoDEX mainnet - https://mainnet-gw.sodex.dev (read-only)
   wallet            0x...
   builder id        12345   (the account's primary account id)
   Spot  vUSDC       130.5   ok (>= 100)
   Perps vUSDC       100     ok (>= 100)

   ELIGIBLE: users can approve a builder fee for this account.

   Lines for apps/web/.env.local:

     VITE_BUILDER_ID=12345
     VITE_BUILDER_FEE_PERPS=50
     ...
   ```

   Without `--fee-*` it prints 50 (5 bp) as a placeholder; choose your own numbers.
4. Put the lines into `apps/web/.env.local`, restart, and run the test of section 9 before any user
   sees it.

---

## 5. How fees are credited, and how to take them out

- SoDEX documents that the fee is credited **in real time, with no claim step**, to the builder account
  **on the engine that produced the fill**: perps fees arrive as vUSDC in the builder's Perps account,
  spot fees as the pair's quote asset in its Spot account. (Consistent with what can be seen from
  outside: the one active builder on SoDEX, whose users sell on spot, held 432.88 vUSDC in Spot on
  2026-09-25 and 630.73 on 2026-10-02, while its Perps balance stayed at exactly 100.)
- The fees are ordinary balance. To take them out, use the builder wallet like any account - in
  ValueDesk itself or on sodex.com: **Transfer** Perps -> Spot, then **Withdraw** from Spot to the
  wallet on ValueChain or to another chain.
- Never withdraw below 100 vUSDC in either engine (section 4).

---

## 6. Reconciliation: the `builderFee` field

What SoDEX reports on a fill (`GET /api/v1/{spot|perps}/accounts/{address}/trades`; read on mainnet
2026-10-02: 400 spot fills, 2026-09-21 to 10-02, of an account that trades through builder 223169 at
10 bp - every fill of a kind has exactly the same rates):

| Fill | n | `fee` (of notional) | `builderFee` | `feeCoin` |
|---|---|---|---|---|
| Spot SELL, taker | 85 | 16.5 bp | 10 bp | vUSDC (quote) |
| Spot SELL, maker | 99 | 13.5 bp | 10 bp | vUSDC |
| Spot BUY, taker | 38 | 6.5 bp | *field absent* | base coin |
| Spot BUY, maker | 178 | 3.5 bp | *field absent* | base coin |

So:

- **`fee` is the total the fill was charged, the builder's part included.** `builderFee` is that part,
  in the same `feeCoin`. Adding `builderFee` to `fee` counts it twice. `fee - builderFee` is SoDEX's own
  commission (it can be negative: a maker rebate).
- `builderFee` is present only on fills that were charged one. A spot buy placed through a builder has
  no such field.
- The rate charged is the order's `fee` (10 bp here), not the approved ceiling (50 bp for these users).
- The WebSocket fill carries the same value as `bf` (documented; not observed).
- A perps fill with a builder has not been observable on SoDEX yet (documented: both sides). The live
  test checks it.

`docs/research/08-gaps-other.md` (G6.2, 2026-09-25) found no `builderFee` key on these very fills; SoDEX
has added the field since. This section replaces point 4 of G6.2.

In code: `fillFeeParts(row)` in `packages/sodex-core/src/builders.ts` returns `{ total, builder, venue }`
from a REST row (`fee`, `builderFee`) or a WebSocket entry (`f`, `bf`), exact on decimal strings.

**In the app.** The trade history's Fee column and every fee total use `fee`, which is already the
total, so they are right with and without a builder and need no change. (A possible refinement for the
history table, in the migration owner's files and therefore not done here: a tooltip "includes x
builder fee" from `fillFeeParts`. Note that `exchange/historyDb.ts` stores fills without `builderFee`,
so all-time totals cannot split the two.)

**For the builder's books.** SoDEX has no per-builder fill feed. Two ways to reconcile income:

1. *The builder account's balance.* With a dedicated, non-trading builder account, growth of its Perps
   and Spot balances is fee income. Simple; no per-fill detail.
2. *Users' fills.* Sum `builderFee` over the fills of the accounts that trade through ValueDesk (their
   fills are public reads). Exact per fill, but ValueDesk does not collect who trades through it - by
   design no order passes a ValueDesk server.

---

## 7. Why the approval is a separate signature

SoDEX documents two ways to approve a builder: the standalone `ApproveBuilderFeeAction`, and
`AddAPIKeyWithBuilder`, which registers an API key and approves a builder in **one** signature. The
app uses the standalone approval, sent **before** its usual key registration. The evidence, all of it
gathered read-only (GET) on 2026-10-02:

| Question | Evidence | Verdict |
|---|---|---|
| Is the app's key registration right? | 85 builder-less registrations read off SoDEX's public CLOB explorer on four accounts: every one recovers the account owner under `UserSignedAddAPIKeyAction` with the wallet's chain as the domain (chains 1, 8453, 4663, 286623, even 31337); none under the documented `AddAPIKey`. It is what sodex.com's web app sends, and what this app has sent since 2026-09-26 | **proven live** |
| Is the `ApproveBuilderFeeAction` typed data right? | The spec; SoDEX's Go SDK (`SignApproveBuilderFeeRequest`) - the same SDK whose registration signer matches the 85 live registrations - reproduced byte for byte for testnet and mainnet, wallet chain and network chain, rates 0, 20, 50, 2000; SoDEX's Python SDK (`client.approve_builder_fee`, and its own test vector) | verified against official code; **not observed live** |
| Does the gateway accept `POST /user/{address}/builders` from a browser? | Documented; the official Python SDK sends exactly this (with the network id as both chain ids). No standalone approval is visible on the explorer for the accounts looked at, and sodex.com's own web app has no builder approval at all | documented, **unobserved** |
| Is the `AddAPIKeyWithBuilder` typed data right? | Four mainnet registrations with a builder (four accounts, both engines, accepted) recover the owner under it. All four used 286623 as the domain chain too | **proven live** (typed data only) |
| Which HTTP request delivers `AddAPIKeyWithBuilder`? | Not readable off the chain. The documented `POST /user/{address}/api-keys` was **rejected live** for a plain registration on 2026-09-26 (the engines verify another struct than the documented one). Whether `/exchange` takes a `builder` is unknown | **unknown** |

The decision, and why it does not rest on the open questions alone:

- **The proven registration stays untouched.** Trading must not break because of a fee. With the
  combined action, an unverified request would replace the one request that is known to work.
- **A user can decline the fee without declining the key** (optional builds), and an approval SoDEX
  refuses does not take the key down with it.
- **The approval outlives the key.** Keys rotate every 7 days; the approval is per account. The
  combined action would re-sign the approval at every rotation. With the separate approval the second
  signature happens once per account, and every later enable is the single signature users know.
- **In a required build a refusal leaves nothing behind**: the approval comes first, so no orphan key
  is registered when it fails.

Cost: one more wallet prompt, once per account.

**Later optimisation.** Once the live test has shown what the gateway accepts, the first enable could
use one signature (`AddAPIKeyWithBuilder`) for accounts with no approval. `packages/sodex-core` already
builds and verifies that typed data (`prepareApiKeyRegistration` with a builder; Go and live vectors);
what is missing is a proven request to carry it.

---

## 9. Manual live test (owner only)

Agents never do this: it needs a real wallet and sends real writes. Budget: the 200 vUSDC parked in the
builder account (not spent), plus two minimum-size orders on a small test account - a few cents of
fees. Use a low fee for the test. Steps 1 to 15 run in a test build with the fee **optional**
(`VITE_BUILDER_REQUIRED=0`), so that declining can be looked at too; steps 16 and 17 in the build as it
ships. (The run that checks the fee guard and the volume tiers against SoDEX is the live runner's -
BUILDER-TIERS.md section 8.)

Have ready: the builder wallet (section 4), and a **different** wallet as the test user with about
25 USDC on SoDEX. Do not use the builder's own account as the test user. Wait about ten seconds between
the `trades` reads - SoDEX rate-limits its history routes.

| # | Do | Expect |
|---|---|---|
| 0 | `node apps/web/tools/check-builder.mjs <builder wallet>` | `ELIGIBLE`; note the builder id and both balances |
| 1 | In `apps/web/.env.local`: `VITE_BUILDER_ID=<id>`, `VITE_BUILDER_FEE_PERPS=10`, `VITE_BUILDER_FEE_SPOT=10`, `VITE_BUILDER_MAX_FEE=10`, `VITE_BUILDER_REQUIRED=0`. Restart the dev server. Open the app with `?debug=trade` | No `TRADING IS OFF` / `the builder fee is OFF` error in the console (the warning that this build makes the fee optional is expected) |
| 2 | `curl -s https://mainnet-gw.sodex.dev/api/v1/user/<test wallet>/builders` | `"data":{"spot":[],"perps":[]}` (or lists without your builder) |
| 3 | Connect the test wallet, press **Enable trading** | The "ValueDesk builder fee" dialog with 0.01 % perps, 0.01 % spot sells, maximum 0.01 %, your builder id |
| 4 | Press **Approve and enable trading** | Wallet prompt 1 is typed data `ApproveBuilderFeeAction`: `chainID` 286623, `accountID` = the test account, `builderID` = yours, `maxFeeRate` 10; domain `universal`. Then wallet prompt 2: the key registration. Toast: "Trading enabled. Orders placed here carry the ValueDesk builder fee you approved." |
| 5 | Repeat the `curl` of step 2 | Your builder in **both** lists: `{"userID":…,"builderID":<id>,"feeRate":10}` |
| 6 | Order ticket, perps: look at the fee lines, then place the smallest market order SoDEX accepts | A line "ValueDesk fee builder +0.0100%"; the review shows "Est. ValueDesk fee". The order fills |
| 7 | `curl -s "https://mainnet-gw.sodex.dev/api/v1/perps/accounts/<test wallet>/trades?limit=5"` | The fill has `builderFee` = price x quantity x 0.0001, and `fee` = SoDEX's fee + `builderFee` |
| 8 | Close the position from the positions table and read the trades again | The closing fill carries `builderFee` too (perps: both sides) |
| 9 | Place a perps limit order away from the market; `curl -s https://mainnet-gw.sodex.dev/api/v1/perps/accounts/<test wallet>/orders`. Then drag it on the chart to a price that fills, and read the trades | The resting order shows the builder (`builder` with your id and rate). After the edit, note whether the fill has `builderFee` - either answer is a finding, not a failure (section 2.2). Close the position again |
| 10 | Spot: buy a little of a coin, then sell it. Read `…/spot/accounts/<test wallet>/trades?limit=5` | The BUY has no `builderFee`; the SELL has it. The ticket said "none on spot buys" for the buy |
| 11 | `node apps/web/tools/check-builder.mjs <builder wallet>` | Perps balance up by the sum of the perps `builderFee`s, Spot balance up by the sell's |
| 12 | Reload the page | Trading is still on, the fee line is still there (the approval was re-read). No wallet prompt |
| 13 | Order ticket: press **ValueDesk fee** -> **Revoke builder approval** | One wallet prompt: the same message with `maxFeeRate` 0. "Builder approval revoked. Orders placed here no longer carry the ValueDesk fee." |
| 14 | The `curl` of step 2 again; then place one more small order and read its fill | Both lists without your builder; the fill has no `builderFee`, the ticket no ValueDesk line |
| 15 | Address menu -> **Sign out**, connect again, press **Enable trading**: first answer **Cancel**, then press it again and answer **Enable without the fee** | Cancel: nothing changes, no wallet prompt. Then: trading on without the fee, one wallet prompt, no ValueDesk line in the ticket |
| 16 | The build as it ships, and approving later: remove `VITE_BUILDER_REQUIRED=0`, restart, reload (the key of step 15 is still in the browser). Try a small order. Then press **ValueDesk fee** in the ticket -> **Approve builder fee** -> **Approve the fee** | The ticket shows the ValueDesk line; the order is refused with "... press "ValueDesk fee" in the order ticket and approve it there". The dialog has two buttons (Cancel, Approve the fee) and does not mention enabling. After the one signature (`ApproveBuilderFeeAction`, no key registration) the same order goes out and its fill has `builderFee` |
| 17 | Same build: **Sign out**, connect again, **Enable trading**, press **Cancel** in the dialog | The dialog has no "Enable without the fee". Trading stays off with the "requires approving its builder fee" message; no wallet prompt at all. Revoke again (step 13) when you are done: in this build revoking also turns trading off |

Afterwards `__vs.dump()` in the console gives the whole log for the record.

**If step 4 or 5 fails** - SoDEX answers with an error, or the lists stay empty:

1. Copy the `builder fee: the approval did not go through` log entry (it holds SoDEX's code and
   message) and the request and response of `POST …/builders` from the browser's network tab. A
   request that is blocked before it is sent (a CORS error in the console) is a different finding from
   one SoDEX answers - note which it is.
2. Try once more with the wallet switched to **ValueChain** (chain id 286623) before pressing Enable.
   The app signs with whatever chain the wallet is on, as it does for the key; SoDEX's own Python SDK
   always signs approvals with 286623 as the domain chain. If it works there and not on another chain,
   the fix is to switch the wallet for this one signature.
3. If it fails there too, the standalone route is not what the gateway accepts from a browser. The
   candidates are then the combined `AddAPIKeyWithBuilder` (typed data proven, section 7) and an
   `/exchange` action for the approval. Nothing is lost meanwhile: in an optional build trading works
   without the fee.

The same test can be run unattended with the live end-to-end runner
(`apps/web/e2e/live/README.md`, "The builder fee"): `--only enable-trading,orders,revoke-builder` with a
`builder` block in its config. It does not check that SoDEX charged the fee; steps 7 to 11 do.

---

## 10. Verified, and not

Verified without a wallet (tests, section 11, and read-only mainnet data):

- every byte the app signs for the approval and for orders with a builder, against SoDEX's Go SDK
  vectors, a literal port of the Python SDK's digest, and viem as an independent EIP-712
  implementation;
- the typed data of `AddAPIKeyWithBuilder` and of the app's key registration, against 89 real
  registrations on mainnet;
- the shape of `GET /user/{address}/builders` and the per-engine rule (spot 500 / perps 200);
- that `fee` includes `builderFee`, that spot buys are not charged and makers are;
- the whole flow against a fake gateway that verifies each signature and rejects an order naming an
  unapproved builder: already approved, approve, decline, wallet rejection, gateway rejection, one
  engine only, lagging and lost answers, restore, revoke - in both modes;
- the fee guard: every action type classified, and each local manipulation - the stored approval
  deleted, edited or forged, the approval revoked or lowered on SoDEX, the terms request blocked, the
  terms answer rewritten or replayed, terms that ran out, planted storage keys and URL parameters -
  ending in the builder at the fee owed, or in no order (unit tests, and in a real browser against the
  fakes);
- the signed terms: the message byte for byte, real Ed25519 signatures through WebCrypto, every
  rejection of BUILDER-TIERS.md section 3.

Not verifiable without a real wallet (the live test settles 1 to 6):

1. that SoDEX's gateway accepts the standalone approval the way the app sends it (browser, CORS,
   wallet chain in the domain and `X-API-Chain`);
2. how fast the listing follows an approval, and that a revocation empties both lists;
3. a perps fill with a builder fee, on both sides, and the `bf` field on the WebSocket;
4. that the fee arrives in the builder's balance in real time;
5. how real wallets display the approval message;
6. SoDEX's error texts for the refusals the app handles generically (a builder below its minimum, an
   eleventh approval, a self-approval);
7. what SoDEX does with orders that name a builder whose balance fell below the minimum afterwards -
   keep the account funded rather than find out.

---

## 11. Where the code is

| Part | File |
|---|---|
| Typed data, request assembly, signature checks | `packages/sodex-core/src/userSigned.ts`, `registration.ts` (`prepareBuilderFeeApproval`), `actions.ts` (`builderFragment`) |
| Reading approvals, fee arithmetic, splitting a fill's fee | `packages/sodex-core/src/builders.ts` |
| Settings | `apps/web/src/trading/config.ts` |
| The fee a wallet owes now; asking for, verifying and holding the signed terms | `apps/web/src/trading/terms.ts` (`feeNow`, `refreshTerms`, `configureTerms`) |
| The gate every signed action passes; what an order placed now carries | `apps/web/src/trading/feeGuard.ts` (`guardAction`, `builderNow`, `MODIFY_KEEPS_BUILDER`, `REPLACE_KEEPS_BUILDER`) |
| Decisions (what to attach, what to quote, what to tell the user) - pure | `apps/web/src/trading/builder.ts` |
| The approval on the wire (read, sign, send, poll) | `apps/web/src/trading/builderApproval.ts` |
| The flow (enable, restore, refresh, approve later, revoke) | `apps/web/src/trading/session.ts` (`enableTrading`, `refreshBuilderApproval`, `approveBuilderFee`, `readBuilderApproval`, `revokeBuilderApproval`) |
| Attaching to orders, signing (the gate stands here), changing an order | `apps/web/src/trading/actions.ts` (`placeOrder`, `signAndSend`, `changeOrder`, `changeRoute`, `recreateOrder`) |
| Order shapes (modifier, trigger type, exits) | `apps/web/src/trading/orderParams.ts` (`placeOrderAction`, `triggerTypeFor`) |
| Disclosure dialog | `apps/web/src/components/account/BuilderConsent.tsx` |
| Fee lines | `apps/web/src/components/account/useBuilderFee.ts`, `OrderEntry.tsx`, `ReviewPosition.tsx`, `FeeTier.tsx` |
| Telling the terms about a fill | `apps/web/src/components/account/BuilderTermsFollower.tsx` |
| Revoke | `apps/web/src/components/account/AdvancedKeys.tsx` |
| Builder check | `apps/web/tools/check-builder.mjs` |
| Live runner support | `apps/web/e2e/live/` (`config.ts`, `guard.ts`, `steps.ts`, `plan.ts`) |

Tests (`npx tsx --test`, node:test):

- `packages/sodex-core/test/builders.test.ts` - type strings, field order, domain rules, signature
  prefix and `v`, Go vectors (testnet and mainnet, wallet chain and network chain, `maxFeeRate` 0 and
  2000), the Python SDK's digest and its own test vector, the live registrations, approvals, units,
  fills. Vectors: `test/vectors-sdk.json` (Go SDK, `tools/genvectors`), `test/vectors-live.json`
  (mainnet, read from the explorer).
- `apps/web/src/trading/builder.test.ts` - the settings (required by default, a broken build has
  trading off, the pinned keys), the decisions and the fee quote.
- `apps/web/src/trading/terms.test.ts` - the signed terms, against a server that signs with a real
  Ed25519 key: the message, every rejection, how long they hold, what they are asked for and when.
- `apps/web/src/trading/feeGuard.test.ts` - the gate for every action type, and that the app signs in
  one place only, behind the gate.
- `apps/web/src/trading/feeGuardFlow.test.ts` - the session with the gate and the terms: what an
  order carries, every local manipulation, the milestone, changing an order as cancel + new.
- `apps/web/src/trading/builderFlow.test.ts` - the session flow against a fake wallet and a fake
  gateway that verifies the approval and order signatures.
- `apps/web/e2e/live/simulate.test.ts`, `safety.test.ts` - a whole run with a builder: the approval
  signature recovers the owner, every order carries the builder last, the revocation clears it; the
  write guard lets exactly the approval body through.
