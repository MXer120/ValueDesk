# Builder fee: enforcement, and per-user tiers that follow verified volume

Status: **contract** (2026-10-02). The server module, the app and the tests are built against this page;
whoever finds reality differs corrects the page in the same change.
Background: [BUILDER-CODES.md](BUILDER-CODES.md) (how builder codes work on SoDEX and in the app) and SoDEX's
own page <https://sodex.com/documentation/for-developers/developers/trading/builder-codes-in-trading>.

Fees are in tenths of a basis point, as SoDEX signs them: `20` = 2 bp = 0.02 % of the notional.

## 1. What is guaranteed, and what is not

**Guaranteed in the app we ship (unmodified):**

- Every order placed through Valuescan carries our builder at the fee that wallet owes. There is no way to
  trade through the app without it: declining the approval, revoking it on SoDEX or lowering it leaves trading
  off until it is approved again.
- Nothing a user can change locally removes or lowers the fee: not browser storage, not the address bar, not
  console hooks, not blocking a request, not rewriting a response of our API in the developer tools. Every one
  of those ends in the **default (highest) fee** or in no order at all - never in a lower fee.
- A lower fee is only ever applied on the strength of a statement **signed by our server** for that wallet,
  that request and a short time.

**Guaranteed on the server:**

- The volume a wallet is credited with comes from SoDEX's own records, read by our server: the wallet's
  fills (what was paid) and, for each order behind them, the signed request on SoDEX's public explorer (which
  builder it names, at which fee, signed by which key). The app reports nothing. Only volume that actually
  paid the fee owed, to our builder, counts (§5).

**Not possible for anyone, by design of SoDEX builder codes:**

- A person who rewrites the app's code, or writes their own program, can send orders to SoDEX without our
  builder. SoDEX accepts any order signed by a key the wallet registered, and a builder cannot be forced onto
  an order. Such a person gets no credit and no discount here, and loses nothing compared with trading on
  sodex.com directly - which they could always do.
- It cannot be prevented, but it can be found out. The gateway's order records do not say which key sent an
  order; SoDEX's public explorer does - it returns every order's signed request, and the key is recovered
  from the signature. An order that does not carry our fee and was signed by the key **our app** registered
  for the wallet is something the unmodified app never sends: the wallet is flagged `tampered` (§5), with
  the order and the transaction kept for the operator. A person who also registers a key of their own is
  just someone trading elsewhere, and is left alone.
- The only ways to make that impossible are (a) sending every order through our own server, which holds or
  co-signs the trading key - that reverses "orders go from the browser to the exchange", makes us part of
  every trade and raises the licensing question the legal research answered against - or (b) SoDEX binding a
  builder to an API key. (b) is a request to SoDEX, not something we can build.

## 2. The fee guard (app)

G1. **Required by default.** A build that sets `VITE_BUILDER_ID` requires the approval; only an explicit
    `VITE_BUILDER_REQUIRED=0` makes it optional (never in a public build). A build that names a builder
    but whose fee settings cannot be read (a typo, a `VITE_BUILDER_REQUIRED` that is neither `0` nor `1`,
    both fees 0) has **trading off**: it does not fall back to trading without the fee.

G2. **One gate for every signed action**: `guardAction` in `trading/feeGuard.ts`, called by `signAndSend` in
    `trading/actions.ts` right before the signature - the only place the app signs an exchange action (a
    test fails when a second one appears). The action type is classified exhaustively: the table is typed
    over `@sodex-core`'s `ActionType`, so a new type does not compile until it is classified, and a type
    the gate does not know is refused.
    - *creates orders and can carry a builder* (new order, batch): must carry `{ id: pinned builder, fee }`
      with `fee` **no less than the fee owed now and no more than the build's default**, on every engine
      whose default fee is above 0; no leg may name a builder of its own. Otherwise the action is refused,
      not sent. (An order is built a moment before it is signed and the gate reads the fee owed again: one
      built just before a lower tier arrived still goes out at the higher fee; one built just before its
      terms ran out is refused.) On an engine the build does not charge on, an order carries no builder.
    - *creates orders and cannot carry a builder* (TWAP): refused in a build that requires the builder.
    - *changes an existing order* (modify, replace): see G6.
    - *everything else* (cancel, leverage, margin, transfers, withdrawals, schedule-cancel): unaffected.

    In an optional build (`VITE_BUILDER_REQUIRED=0`) an order may leave without the builder; one that
    names a builder is still held to the same rule. With no builder configured the gate does nothing.
    There is no switch that turns it off.

G3. **Where the fee comes from.** `fee owed now` = the default fee of the build (`VITE_BUILDER_FEE_*`), lowered
    only by terms that verify (§3) for the connected wallet. No other input exists: no storage key, URL
    parameter, debug hook or unsigned field can change it. The fee is never above the default or SoDEX's caps
    (perps 200, spot 2000).

G4. **The approval** is asked for `VITE_BUILDER_MAX_FEE`, which is at least the default fee, so a tier change
    never needs another signature. What the browser remembers about the approval is a hint for the screen
    only: in a build that requires the builder, an order is sent with the builder or not at all.
    Remembered as missing, SoDEX is asked before the order; remembered as there when it is not (revoked,
    lowered, or forged in the browser's storage), the order goes out naming the builder and SoDEX rejects
    it, after which the app re-reads and sends nothing until the approval is back.

G5. **No terms, no discount.** Terms missing, unverifiable, signed by a key that is not pinned, for another
    wallet, for another builder or chain, expired, or answering another request: the default fee.

G6. **Changing an order.** SoDEX's modify and replace requests have no builder field. Whether the changed
    order keeps the builder of the original is checked by the live run (§8). `REPLACE_KEEPS_BUILDER` and
    `MODIFY_KEEPS_BUILDER` are constants in one place: `true` (proven) uses the request; `false` or unknown
    does the change as cancel + new order with the builder. Until the live run has proven them: modify (same
    order id) is assumed to keep it, replace is not. The constants are in `trading/feeGuard.ts`
    (`MODIFY_KEEPS_BUILDER = true`, `REPLACE_KEEPS_BUILDER = false`); the gate refuses the request itself
    where the constant is false, so no path can send it by mistake.
    Cancel + new order is two requests and not atomic. Before the cancel the order is read from SoDEX,
    rebuilt, validated against the market's rules and its builder decided; an order that cannot be rebuilt
    exactly (attached exits, sized in funds, side or type not listed) is refused and left as it is. If
    SoDEX refuses the new order after the cancel, the user is told in plain words that the original is gone.

G7. **Spot buys** carry the builder like any order; SoDEX charges nothing on that side, and they never count
    as volume (§5).

G8. **A fee of 0.** Terms may say 0 (an override). The order then carries `{ id, fee: 0 }` - it still names
    the builder. Whether SoDEX accepts a builder fee of 0 on an order has NOT been checked: do not set a
    tier or an override to 0 before the live run has shown it. If SoDEX rejects it, that wallet cannot
    trade here until its fee is above 0 again (it fails closed).

## 3. Signed terms

Request: `GET /api/vs/builder/terms?address=0x...&nonce=<16-64 chars of [A-Za-z0-9_-]>[&hint=1]`.
The nonce is random per request and never reused. The response is `Cache-Control: no-store, no-transform`
(no ETag, never compressed). `hint`, when given, must be `1`. An address, a nonce or a hint that does not
match - or a parameter given twice - is answered `400 { "ok": false, "error": "..." }` and signs nothing.
A request can do two things only: ask, and leave a hint. Asking writes nothing on the server.

```json
{
  "ok": true,
  "chain": 286623,
  "builderId": 123456,
  "address": "0x...",
  "fee": { "perps": 15, "spot": 20 },
  "nonce": "<as sent>",
  "issued": 1790000000000,
  "ttl": 600000,
  "keyId": "1a2b3c4d",
  "sig": "<base64url Ed25519 signature>",

  "default": { "perps": 20, "spot": 20 },
  "volume": { "perpsUsd": 12.4, "spotUsd": 0, "totalUsd": 12.4, "verifiedAt": 1790000000000, "pending": false },
  "tier": { "index": 1, "next": null },
  "flags": []
}
```

The signature covers exactly these bytes (UTF-8, lines joined by `\n`, no trailing newline):

```
valuescan-builder-terms/1
chain:286623
builder:123456
address:0x<lowercase>
perps:15
spot:20
nonce:<nonce>
issued:1790000000000
ttl:600000
```

- Key: Ed25519. The server holds the private key (a PKCS#8 PEM file); the app pins one or more public keys
  (`VITE_BUILDER_TERMS_KEYS`, comma separated, base64url of the raw 32 bytes). `keyId` = the first 8 hex
  characters of SHA-256 of the raw public key, so keys can be rotated.
- The app rebuilds the message **from the values it is about to use** and verifies it with WebCrypto. It
  accepts the terms only when: the signature verifies under a pinned key; `chain` is the chain it trades on;
  `builderId` is the pinned builder; `address` is the connected wallet; `nonce` is the one it just sent; both
  fees are integers from 0 to the build's default for that engine (a build that does not charge on an
  engine accepts only 0 there); `issued` is a whole number and `ttl` a positive one. `keyId` only says
  which pinned key to try first: terms that verify under any pinned key are accepted, terms that verify
  under none are not, whatever `keyId` claims.
- `ttl` is capped at 15 minutes and counted on the browser's monotonic clock from the moment the answer
  arrived (`issued` is signed but not used for it). The system clock cannot extend terms; it can only end
  them early - when the wall clock has moved past the ttl the terms are over, which covers a machine that
  slept (some browsers' monotonic clock stands still meanwhile).
- Verified terms live in memory only - nothing is cached across page loads. A refresh that fails or does
  not verify does not remove terms already verified: they hold until their own ttl ends, then the default
  applies. The newest verified answer always replaces the one held, also when its fee is higher.
- A browser without Ed25519 in WebCrypto, or a build without pinned keys, always pays the default fee - and
  sends no terms request at all.
- `volume`, `tier`, `flags` and `default` are for display. They are not signed and decide nothing.
- `volume.pending` is true while a verification of the wallet is queued or running, or while orders of the
  wallet wait to be looked up (§6). `volume.verifiedAt` is null for a wallet that was never verified.
- With the feature off (no config file) the answer is `{ "ok": true, "builderId": null }`.
- Without a key file the answer has `"sig": null` and `"keyId": null`: every app with pinned keys then uses
  the default fee.
- When the server cannot answer, the answer is `200 { "ok": false, "code": "unavailable", "error": "..." }`:
  no terms, so the default fee.
- `tier.next` is `{ "atUsd": number, "fee": { "perps": n, "spot": n } }`, or null on the last tier. `tier`
  is the tier of the wallet's volume, also while a flag or an override sets another fee.
- `flags`: `underpaid`, `tampered`, `override`, `no-builder` (§5), in that order. Nothing else is ever in
  the list: anyone can ask for any address, so no text, order id or key appears in an answer.

**A fixed vector** both sides check (`apps/server/test/builderTerms.vector.json`, three messages). The key
is a TEST key - the seed is the bytes `00 01 ... 1f` - and Ed25519 is deterministic, so the signature must
come out byte for byte:

```
seed (hex)   000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
public key   A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg      (base64url of the raw 32 bytes; this is what gets pinned)
keyId        56475aa7
message      valuescan-builder-terms/1\nchain:286623\nbuilder:123456\naddress:0xabababababababababababababababababababab\n
             perps:15\nspot:20\nnonce:AAAAAAAAAAAAAAAAAAAAAA\nissued:1790000000000\nttl:600000
sig          jGEDlHgiyK5gGlaulDSDIgY-yC3vRb-ZnG7YdQzqUpoq9vF4pTlFnJU7RtNTqh0MXeB8jDge9HZsZF21PWR_Cw
```

## 4. Configuration (server)

One JSON file, re-read when it changes (looked at every 5 s, no restart). Path: `VALUESCAN_BUILDER_TIERS_FILE`,
default `builder-tiers.json` in the server's data directory - the directory of the device key
(`VALUETRADE_DEVICE_KEY`; on the instance `/var/lib/valuescan/state`, outside the synced tree on a
workstation). Missing file = the feature is off and the app charges the fees of its build; deleting the file
is the kill switch.

```json
{
  "builderId": 123456,
  "maxFeeRate": 20,
  "tiers": [
    { "minVolumeUsd": 0,  "perps": 20, "spot": 20 },
    { "minVolumeUsd": 10, "perps": 15, "spot": 20 }
  ],
  "overrides": {
    "0x0000000000000000000000000000000000000001": { "perps": 10, "spot": 10, "note": "partner" }
  },
  "underpaid": { "policy": "default-fee", "days": 30 }
}
```

- `tiers` are sorted by `minVolumeUsd` (strictly rising), the first starts at 0. A wallet's tier follows its
  **total counted volume** (perps + spot), lifetime: the last tier whose `minVolumeUsd` it has reached.
- Every fee is a whole number. A fee may never exceed the first tier's fee for that engine, `maxFeeRate`, or
  SoDEX's caps (perps 200, spot 2000). The first tier must equal the default fee of the web build (the app
  clamps to its own default anyway).
- `overrides` set one wallet's fee by hand, within the same limits; it wins over the tier and the policy.
  `note` is for the operator and is never sent.
- `underpaid.policy`: `default-fee` (a wallet with an `underpaid` or `tampered` order in the last `days`
  days is on the default fee) or `ignore`. Left out: `default-fee`, 30 days.
- A setting this page does not name is a mistake, not something to skip (`"overides"` would otherwise drop a
  partner's fee in silence); names starting with `_` are free for notes. An invalid file is rejected as a
  whole; the last valid one stays in force and the problems are logged.
- The signing key: `VALUESCAN_BUILDER_TERMS_KEY_FILE`, default `builder-terms.key` in the same directory; it
  too is picked up without a restart. The ledger: `VALUESCAN_BUILDER_DB`, default `builder.db` there.
- Budgets (`deploy/server/env/api.env.example`): `VALUESCAN_BUILDER_VERIFY_PER_MIN` (default 1, at most 2),
  `VALUESCAN_BUILDER_APPROVALS_PER_MIN` (10, at most 30), `VALUESCAN_BUILDER_EXPLORER_PER_MIN` (3, at most
  6; 0 switches lookups - and with them all counting - off), `VALUESCAN_BUILDER_LOOKBACK_DAYS` (7, 0 to 90),
  `VALUESCAN_BUILDER_EXPLORER` (the explorer's https origin).

Tool (run in `apps/server`; prints one JSON object; never prints the private key; exit code 0 done,
1 refused, 2 not understood):

- `npx tsx tools/builderTiers.ts init --builder-id <n> (--test-tiers | --fee-perps <n> --fee-spot <n>) [--force]`
  writes the config and the key where they do not exist, and prints
  `{ configPath, keyPath, publicKey, keyId, builderId, tiers, configWritten, keyWritten }`. `--test-tiers`
  writes exactly the example above without `overrides`; `--fee-*` writes one tier, the default fee.
  `--force` replaces the configuration; **the key is never replaced** (builds pin it). A configuration that
  exists and names another builder is refused without `--force`.
- `npx tsx tools/builderTiers.ts status [--address 0x...]` prints `{ configPath, valid, problems, builderId,
  tiers, keyPath, publicKey, keyId, ... }`; with an address, what the ledger holds for that wallet: volume,
  flags, the fee history, the app's keys on record and the evidence behind each flag (order id, transaction
  hash, signing key). Read-only.
- `npx tsx tools/builderTiers.ts forget --address 0x...` removes everything the server stored about ONE
  wallet - volume, counted orders, fee history, flags, recorded keys, evidence, its place in the queue - in
  one transaction, while the server runs, and prints `{ address, removed: { <table>: rows }, total,
  countsFrom }`. Anything but exactly one well-formed address is refused. The wallet's next request starts
  from nothing (the server keeps nothing about a wallet in memory that could write the old rows back), and
  its orders from before the command are never read again: it can run the fee-change test once more.

## 5. What counts as volume

Source - all public reads by the server, never anything the app sends:

- the wallet's **fills** (`GET /api/v1/{spot,perps}/accounts/{address}/trades`): `price`, `quantity`, `side`,
  `orderID`, `time`, and `builderFee` - present only on a fill SoDEX charged a builder fee, and then exactly
  notional x rate / 100 000;
- for each order behind fills that matter, the order's **signed request** on SoDEX's public explorer
  (`GET https://clobscan-mainnet.sodex.dev/api/v1/{spot|perps}/transaction?account_id=&order_id=`): the
  builder it names and at which fee, when SoDEX took it, and the signature - from which the key that sent it
  is recovered (EIP-712 `ExchangeAction` in the engine's domain).

Not the order history: read on mainnet (2026-10-02), `orders/history` rows of finished orders carry **no**
`builder` - only open orders (`/orders`) do - so they cannot say whose builder an order named, and
`executedValue` alone says nothing about what was paid.

An order's fills count when all of these hold:

1. the request names our builder (per order on perps, else the batch's);
2. at a fee of at least the fee the wallet owed on that engine when the order was created (below);
3. SoDEX charged it: the fill carries `builderFee` - every perps fill, on spot only **sells** (spot buys
   never count);
4. the pair is quoted in a dollar coin (`vUSDC`, `USDC`, ... - perps always) and the fee was paid in one.

Counted volume = price x quantity of those fills, exact (no floats), in whole millionths of a dollar. An order
that fills further later adds its new fills, once; reading the same fills again adds nothing. An engine whose
default fee is 0 is not read at all.

*The fee owed at a time `t`* is the lowest fee in force for that wallet at any moment from `t - grace` to
`t + 2 minutes`, where grace = the terms `ttl` plus two minutes: terms signed just before the fee rose stay
valid for their `ttl`, and SoDEX's clock may run a little behind ours. In force at a moment is the fee the
server last signed for the wallet - it records one row each time that changes - and for a wallet with no row
yet, the default fee of that moment (the server records the default each time the file changes it, so raising
the default never makes earlier orders underpaid). A wallet that never asked for terms owes the default.

Flags (kept per wallet, with the count and the last time; in a terms answer only the four names):

- `underpaid`: an order names our builder below the fee owed. It does not count; the policy in §4 applies.
- `tampered`: an order that does not carry our builder at the fee owed (another builder, a lower fee, or
  none), created after the ledger began, on an engine with a fee, and **signed by a key our app registered
  for the wallet** (name `valuescan-web` / `valuescan-mobile`, as listed by
  `GET /{engine}/accounts/{address}/api-keys` and kept with its history, since keys rotate). The unmodified app
  never sends such an order. It does not count; the same policy as `underpaid` applies; the order id and the
  transaction hash are kept for the operator (`status --address`). An order signed by any other key proves
  nothing and is the user's own business.
- `no-builder`: an order whose client order id has the app's prefix (`vs-`, `tp-`, `sl-`) paid no builder fee
  where one was owed. Monitoring only, it changes no fee; it costs nothing (it is seen in the fills already
  read). `tampered` is the proof; this is the hint.
- `override`: the wallet's fee is set by hand.

The builder account's balance is the income; the live run reconciles it with the `builderFee`s.

## 6. Verification (server)

Three lanes, each with a budget of its own, each asleep while it has nothing to do:

- **Approvals.** A hint for a wallet the ledger does not know costs one public read,
  `GET /api/v1/user/{address}/builders` (weight 20, `VALUESCAN_BUILDER_APPROVALS_PER_MIN`). Not approved:
  the hint is dropped and the wallet is not asked about again for a minute. Approved: the wallet gets a
  row and a place in the queue; its fills are read from 7 days before (`..._LOOKBACK_DAYS`). One client may
  name at most 6 unknown wallets a minute; the queue holds 200, a full queue drops the newest hint.
  **A request without a hint, or for a wallet without an approval, writes nothing.**
- **History.** One page of fills (`/trades`, limit 1000) per step, perps then spot, from a little before the
  newest fill already read (2 minutes of overlap, told apart by fill id). SoDEX limits `/orders/history` and
  `/trades` together to about 4 requests per 60 s per IP, and the safe rate for the pair is 2 per 60 s
  (`SODEX_HISTORY_PAIR_PER_MIN`): the lane sends at most `VALUESCAN_BUILDER_VERIFY_PER_MIN` (default 1,
  never above 2), evenly spaced, through the shared SoDEX client (its weight budget, its cooldown; it waits
  while more than 800 of the minute's 1200 weight is spent). The time of the last request and any pause are
  kept on disk, so restarts cannot add up to a burst. A rate-limit answer stops the lane for 5 minutes,
  doubling to 30, and is never retried into; a failed page rests the lane four slots (the client may have
  retried it). Nothing else on the same IP may read those two paths meanwhile (the indexer's `/trades` drip
  stays off). A sweep stops after 20 pages; the wallets in the queue take turns, productive ones first.
- **Explorer.** One order's request per step, at most `VALUESCAN_BUILDER_EXPLORER_PER_MIN` (default 3, at
  most 6). The explorer publishes no limits: any answer that is not a 200 stops the lane for 10 minutes,
  doubling to 6 hours. An order it does not know is asked for again after 30 s, 2 and 10 minutes, then left
  uncounted. Builder-less orders are looked up only for wallets that have a key of our app on record, two
  per page of fills at most, the app's client order ids first.
- A wallet is verified at most once a minute, and twice as long after each pass that found nothing new (up to
  30 minutes); 500 wallets can wait in the queue. One wallet is normally verified, and its fee lowered,
  within a minute or two of its hint. That delay never works in the wallet's favour.
- State lives in a small database of its own (`builder.db`), written only by the process that serves the
  terms (and by the tool's `forget`). It never writes the index database. Every statement is one row or a
  short indexed range; nothing about a wallet is kept in memory between two steps but its place in the
  queue, and a step writes only if the wallet's row is still the one it read.

## 7. The app

- The build pins `VITE_BUILDER_ID`, `VITE_BUILDER_MAX_FEE`, the default fees `VITE_BUILDER_FEE_PERPS` /
  `VITE_BUILDER_FEE_SPOT`, and `VITE_BUILDER_TERMS_KEYS`.
- Terms are asked for when trading is enabled or restored; every 4 minutes while trading is on (at half the
  ttl when that is shorter, never more often than every 30 s; every 30 s, up to six times, while the answer
  says `volume.pending`; three retries a minute apart when the API does not answer); and after a fill, with
  `hint=1`, 3 s later and at most once a minute per wallet (a fill = a push on SoDEX's `accountTrade`
  stream, or an order the app just placed). Before an order is built, a wallet with no terms held is asked
  about once more, waiting at most 1.5 s - an order is never held up or refused over terms.
- The request goes to the origin the app is served from (`/api/vs/builder/terms`), never to SoDEX.
- The order ticket shows the fee the order will carry - with the default struck through beside it when a
  lower tier applies - and the next tier when the terms name one; the order review and the fee panel use
  the same number.
- Module `apps/web/src/trading/terms.ts` (the live runner uses the same module from Node):
  - `configureTerms({ keys, endpoint?, fetch?, monotonicNow?, wallNow? })` - use these instead of the
    build's (`keys`: base64url public keys; `endpoint` default `/api/vs/builder/terms`; `fetch(url, init)`;
    the two clocks in ms). Forgets everything held.
  - `refreshTerms(address, { hint? }): Promise<VerifiedTerms | null>` - ask and verify; never throws.
  - `feeNow(engine, address): number` - what an order placed now carries (0: no builder, or the engine is
    not charged).
  - `currentTerms(address)`, `termsView(address)` (for the screen), `ensureTerms(address, maxWaitMs?)`,
    `followTerms(address | null)`, `hintTerms(address)`, `subscribeTerms(fn)`, `termsRevision()`,
    `termsPossible()`, and the pure parts `termsMessage(fields)`, `readTermsAnswer(body, expect)`,
    `termsKeyId(publicKey)`.
- Module `apps/web/src/trading/feeGuard.ts`: `guardAction(action, owner)` (the gate),
  `builderNow(engine)` - **the builder an order placed now must carry** (`{ id, fee }`, or undefined when it
  carries none) - `classifyAction(type)`, `mustRecreate(type, engine)`, and the two G6 constants.

## 8. Tests

- Unit (server, `apps/server/test/builder*.test.ts`): config validation, tier selection, the counting rules
  (other builders, underpaid orders, spot buys, other quote coins, orders that fill further, both engines,
  checkpoints across a restart, running twice changes nothing), the fee owed over time (also when the default
  changes), hint limits and back-off, the budgets (never two history reads in a minute, restarts, rate
  limits, the explorer stopping on a non-200), a flood of requests for random addresses (no row, no request,
  bounded queues), `tampered` only with the app's own key, `forget` while the server runs, the route's checks
  and headers, the tool, and the signature against the fixed vector (`apps/server/test/builderTerms.vector.json`,
  which the app's tests check too). Real explorer and gateway answers are in
  `apps/server/test/builderExplorer.fixture.json`.
- The live run's cheating step, as a unit test: the tier is reached, then an order at a lower fee and one
  without a builder - neither counts, `underpaid` is raised, and the next terms are the default fee.
- Unit (app): the gate for every action type; each local manipulation of §1 ends in the default fee or a
  refusal; terms with a changed fee, a wrong nonce, another address, another builder, another chain, an
  expired answer or an unknown key are rejected.
- Simulated end-to-end run: volume passes the milestone, the fee drops, the next order carries the lower fee.
- Live (run by the owner, `RUN-LIVE-TESTS.cmd`):
  1. the first orders carry `20`; the order records show `builder { id, feeRate: 20 }`; each fill's
     `builderFee` is 2 bp of its notional;
  2. more than 10 USDC of volume; hint; the terms change to `15`;
  3. the next order carries `15`; its fill's `builderFee` is 1.5 bp;
  4. an order sent with a lower fee, and one without a builder (sent by the test, around the app's gate),
     are not counted, and the first raises `underpaid`;
  5. a modified order and a replaced order: does the record still name the builder (G6)?
  6. the approval lowered below the fee owed, and revoked: the app sends nothing until it is approved again;
  7. the builder account's balance rose by the sum of the `builderFee`s of the run.
