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

- The volume a wallet is credited with comes from SoDEX's own records, read by our server. The app reports
  nothing. Only volume that actually paid the fee owed counts.

**Not possible for anyone, by design of SoDEX builder codes:**

- A person who rewrites the app's code, or writes their own program, can send orders to SoDEX without our
  builder. SoDEX accepts any order signed by a key the wallet registered, a builder cannot be forced onto an
  order, and SoDEX's records do not say which program or key sent an order. Such a person gets no credit and
  no discount here, and loses nothing compared with trading on sodex.com directly - which they could always do.
- The only ways to make that impossible are (a) sending every order through our own server, which holds or
  co-signs the trading key - that reverses "orders go from the browser to the exchange", makes us part of
  every trade and raises the licensing question the legal research answered against - or (b) SoDEX binding a
  builder to an API key. (b) is a request to SoDEX, not something we can build.

## 2. The fee guard (app)

G1. **Required by default.** A build that sets `VITE_BUILDER_ID` requires the approval; only an explicit
    `VITE_BUILDER_REQUIRED=0` makes it optional (never in a public build).

G2. **One gate for every signed action** (`trading/actions.ts`, where actions are signed and sent). Before
    signing, the action type is classified - exhaustively, so a new type cannot be forgotten:
    - *creates orders and can carry a builder* (new order, batch): must carry `{ id: pinned builder, fee: the
      fee owed now }` on every engine whose default fee is above 0. Otherwise the action is refused, not sent.
    - *creates orders and cannot carry a builder* (TWAP): refused in a build that requires the builder.
    - *changes an existing order* (modify, replace): see G6.
    - *everything else* (cancel, leverage, margin, transfers, withdrawals, schedule-cancel): unaffected.

G3. **Where the fee comes from.** `fee owed now` = the default fee of the build (`VITE_BUILDER_FEE_*`), lowered
    only by terms that verify (§3) for the connected wallet. No other input exists: no storage key, URL
    parameter, debug hook or unsigned field can change it. The fee is never above the default or SoDEX's caps
    (perps 200, spot 2000).

G4. **The approval** is asked for `VITE_BUILDER_MAX_FEE`, which is at least the default fee, so a tier change
    never needs another signature. What the browser remembers about the approval is a hint for the screen
    only: in a build that requires the builder, an order is sent with the builder or not at all.

G5. **No terms, no discount.** Terms missing, unverifiable, for another wallet, for another builder or chain,
    expired, or answering another request: the default fee.

G6. **Changing an order.** SoDEX's modify and replace requests have no builder field. Whether the changed
    order keeps the builder of the original is checked by the live run (§8). `REPLACE_KEEPS_BUILDER` and
    `MODIFY_KEEPS_BUILDER` are constants in one place: `true` (proven) uses the request; `false` or unknown
    does the change as cancel + new order with the builder. Until the live run has proven them: modify (same
    order id) is assumed to keep it, replace is not.

G7. **Spot buys** carry the builder like any order; SoDEX charges nothing on that side, and they never count
    as volume (§5).

## 3. Signed terms

Request: `GET /api/vs/builder/terms?address=0x...&nonce=<16-64 chars of [A-Za-z0-9_-]>[&hint=1]`.
The nonce is random per request and never reused. The response is `Cache-Control: no-store`.

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
  fees are integers from 0 to the build's default for that engine. `ttl` is capped at 15 minutes and counted
  on the browser's monotonic clock from the moment the answer arrived, so the system clock plays no part.
  Verified terms live in memory only - nothing is cached across page loads.
- A browser without Ed25519 in WebCrypto, or a build without pinned keys, always pays the default fee.
- `volume`, `tier`, `flags` and `default` are for display. They are not signed and decide nothing.
- With the feature off (no config file) the answer is `{ "ok": true, "builderId": null }`.
- Without a key file the answer has `"sig": null`: every app with pinned keys then uses the default fee.
- `tier.next` is `{ "atUsd": number, "fee": { "perps": n, "spot": n } }`, or null on the last tier.
- `flags`: `underpaid`, `override`, `no-builder` (§5).

## 4. Configuration (server)

One JSON file, re-read when it changes (no restart). Path: `VALUESCAN_BUILDER_TIERS_FILE`, default
`builder-tiers.json` in the server's data directory (next to the index database). Missing file = the feature
is off and the app charges the fees of its build.

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

- `tiers` are sorted by `minVolumeUsd`, the first starts at 0. A wallet's tier follows its **total counted
  volume** (perps + spot), lifetime.
- A fee may never exceed the first tier's fee for that engine, `maxFeeRate`, or SoDEX's caps. The first tier
  must equal the default fee of the web build (the app clamps to its own default anyway).
- `overrides` set one wallet's fee by hand, within the same limits.
- `underpaid.policy`: `default-fee` (a wallet with an underpaid order in the last `days` days is on the
  default fee) or `ignore`.
- An invalid file is rejected as a whole; the last valid one stays in force and the problems are logged.
- The signing key: `VALUESCAN_BUILDER_TERMS_KEY_FILE`, default `builder-terms.key` in the same directory.

Tool (run in `apps/server`; never prints the private key):

- `npx tsx tools/builderTiers.ts init --builder-id <n> [--test-tiers] [--force]` writes the config (the
  example above with `--test-tiers`) and the key when they do not exist, and prints
  `{ configPath, keyPath, publicKey, keyId, builderId, tiers }` as JSON.
- `npx tsx tools/builderTiers.ts status` prints `{ configPath, valid, problems, builderId, tiers, keyPath,
  publicKey, keyId }` as JSON.

## 5. What counts as volume

Source: the wallet's order history on SoDEX (`GET /api/v1/{spot,perps}/accounts/{address}/orders/history`, and
the open orders for orders still working). Each order record carries `builder: { builderID, feeRate }`,
`executedValue` (cumulative notional in the quote coin), `side`, `status`, `createdAt`.

An order counts when all of these hold:

1. `builder.builderID` is our builder;
2. `builder.feeRate` is at least the fee the wallet owed on that engine when the order was created (below);
3. SoDEX charges the builder fee on it: every perps order; on spot only **sells**;
4. it has executed value.

Counted volume = the sum of `executedValue` over counted orders. An order that fills further later is counted
by its increase, once.

*The fee owed at a time `t`* is the lowest fee the server had signed for that wallet with a validity reaching
into `[t - grace, t]`, where grace = the terms `ttl` plus two minutes; a wallet that never asked for terms owes
the default. The server records a wallet's fee each time the fee it signs changes.

Flags (kept per wallet, with the count and the last time):

- `underpaid`: an order names our builder below the fee owed. It does not count; the policy in §4 applies.
- `no-builder`: an order whose client order id has the app's prefix (`vs-`, `tp-`, `sl-`) carries no builder
  or another one. Monitoring only: it shows that a modified copy of the app is in use.
- `override`: the wallet's fee is set by hand.

Fills (`/trades`, field `builderFee`) are the audit trail of what was paid. The builder account's balance is
the income; the live run reconciles the two.

## 6. Verification (server)

- SoDEX limits `/orders/history` and `/trades` together to about 4 requests per 60 s per IP, and the safe
  rate for the pair is 2 per 60 s (`SODEX_HISTORY_PAIR_PER_MIN`). The verifier reads at most
  `VALUESCAN_BUILDER_VERIFY_PER_MIN` (default 1, never above 2) through the shared SoDEX client, honours its
  cooldown, and stops on a rate-limit answer. Nothing else on the same IP may read those two paths at the
  same time above the pair's limit (the indexer's `/trades` drip is off by default).
- What is verified: wallets with a hint. A hint is honoured only for a wallet that has approved our builder
  (one cheap public read, cached, on a budget of its own) and at most once per wallet per interval; a wallet
  whose verifications keep finding nothing new is asked less and less often. Queues are bounded.
- Each verification reads from the wallet's checkpoint and stores: counted volume per engine, what was
  already counted per working order, flags, the checkpoint, the time.
- One wallet is normally verified within a minute or two of its hint. That is the delay between reaching a
  milestone and getting the lower fee; it never works in the wallet's favour.
- State lives in a small database of its own (`builder.db` in the data directory), written by exactly one
  process: the one that serves the terms. It never writes the index database.

## 7. The app

- The build pins `VITE_BUILDER_ID`, `VITE_BUILDER_MAX_FEE`, the default fees `VITE_BUILDER_FEE_PERPS` /
  `VITE_BUILDER_FEE_SPOT`, and `VITE_BUILDER_TERMS_KEYS`.
- Terms are asked for when trading is enabled or restored, after a fill (with `hint=1`, debounced) and every
  few minutes while trading is on.
- The order ticket shows the fee the order will carry, and the next tier when there is one.
- Module `apps/web/src/trading/terms.ts` (the live runner uses the same module from Node):
  `configureTerms({ keys, endpoint?, fetch?, monotonicNow? })`, `refreshTerms(address, { hint? })` (verified
  terms or null), `feeNow(engine, address)` (what an order placed now carries).

## 8. Tests

- Unit (server): config validation, tier selection, the counting rules (other builders, underpaid orders,
  spot buys, orders that fill further, both engines, checkpoints, running twice changes nothing), the fee
  owed over time, hint limits and back-off, the signature against fixed vectors.
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
