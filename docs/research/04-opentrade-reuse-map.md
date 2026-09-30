# 04 — Opentrade reuse map for the Valuescan backend

Research date: 2026-09-25. Scope: every file under `Opentrade/server/src`, plus the backend-relevant files in `Opentrade/web/src`. The question is what Valuescan can reuse for four targets:

- **(a) Indexer**: tracks thousands of SoDEX accounts across many tenants.
- **(b) Public read API**: serves Explore, Leaderboard, Scan and Stats.
- **(c) Copy executor**: signs follower orders with delegated keys.
- **(d) Browser**: per DEPLOYMENT.md, signing moves to the browser in the hosted app.

Method: I read every server source file line by line and read the web data-layer files. I ran the existing test suite, which is offline. I checked the live behaviour with **read-only** public calls only: GETs, one CORS preflight `OPTIONS` (not executed), `eth_call`, and two 25–30 s public WebSocket subscriptions. I sent nothing signed, posted nothing, and changed nothing in `Opentrade/`: `git status` was clean before and after. SoDEX docs are cited from the markdown copies another research agent saved to the shared scratchpad; they mirror `sodex.com/documentation/...md`.

Confidence labels: **verified** means I observed it live or in code today. **documented** means official SoDEX docs. **inferred** means my reasoning from evidence. **assumption** means not established.

---

## TL;DR

1. **The signing layer is the crown jewel. Reuse it as-is.** `server/src/signing/{eip712,actions,userSigned}.ts` plus `decimal.ts` and `sodex/symbols.ts` are pure and isomorphic, using only `@noble`. They match the official Go SDK byte-for-byte on 19 vectors. The web build already imports them through a Vite alias (`@sign`). Put them in a shared `@valuescan/sodex-core` package. **Two gaps:** there is no `builder {id, fee}` field on orders, and there is no `AddAPIKey` / `AddAPIKeyWithBuilder` / `ApproveBuilderFeeAction` typed data. Both are needed for monetisation. There are also no test vectors for builders yet.
2. **The biggest indexer finding is a firehose.** The public WS `trade` channel attributes every fill to both accounts. Every print carries `bi` (buyer account id) and `si` (seller account id). All 516 prints I sampled had them, and one connection accepted all 98 perps symbols in one subscribe. So one upstream connection per engine sees every fill on the venue, tagged by account, with **no per-account polling**. The REST `/markets/{s}/trades` does **not** carry `bi`/`si`. Opentrade uses the field only for tape filtering (`TapeFilter.tsx`). None of its backend is built around it.
3. **Account WS channels cannot scale in a hosted backend.** The docs cap WS at **10 unique users per IP** and **1000 subscriptions per IP**. Worse, `accountTrade` and `accountOrderUpdate` pushes carry **no `user` field** (verified). So `hub.ts`'s routing, which reads `msg.data.user`, sends every tracked user's fills to every subscriber of that channel once more than one user shares an upstream. Keep the hub for public market data only. Browsers should subscribe to their own account directly at SoDEX.
4. **`history.ts` is the right backfill algorithm with the wrong storage.** The parts that carry the correctness should be ported unchanged:
   - `walkBackwards`, with an *inclusive* `endTime` and a short-page-plus-no-new-rows terminator;
   - whole-row SHA-1 dedupe, because `tradeID` collides about 1.1% of the time;
   - exact `DecimalSum`;
   - per-page checkpointing;
   - the "HTTP-200 error envelope is never an empty page" rule in `rest.ts`.

   Replace the storage: a single-file SQLite with a raw-JSON column costs about 660 B/row, and the in-process job map needs to become a queue.
5. **Measured volumes.**
   - The trade firehose ran at about **10.9 perps prints/s plus 1.7 spot prints/s**, about 2.6 KB/s of wire JSON (30 s sample). Extrapolated, that is roughly 1M prints/day.
   - One market-maker account alone produced **305k spot + 40k perps fills in about 7 months**, which stored as 231 MB of SQLite.
   - The public leaderboard lists **134,605 accounts**. At `page_size=50` a full crawl is about 2,693 requests, and it gives you every `account_id → wallet` pair.
6. **Opentrade's hosting blockers are now obsolete.** The gateway answers the preflight for signed endpoints with `access-control-allow-origin: *` and allows `X-Api-Key/Sign/Nonce/Chain` (verified). `web/src/signing.ts` already implements browser signing with Web Locks nonces, but **nothing imports it**. The docs also relax nonces: the gateway keeps the **100 highest nonces per signer**, not a strict sequence. So browsers can sign directly and the hosted backend needs **no user keys** except the executor's delegated ones.
7. **The copy executor faces rate limits that Opentrade never had to consider.**
   - Each account is limited to 600 orders/min and 20/s.
   - The **address action quota is 1 request per 1 USDC ever traded, plus 10,000**, and 1 request per 10 s once exhausted. I verified this: `/api/v1/user/{addr}/ratelimit` returns `transactionQuota = cumulativeVolume + 10000`.
   - Each master account can hold at most **5 API keys** and **10 builder approvals** (documented).

   A small follower copying a high-frequency leader will run out of action quota. Filter such leaders out, and poll the ratelimit endpoint.
8. **Treat the venue abstraction as a sketch.** `venues/*` is read-only market data (5 methods). **`venueRoutes` is never registered in `index.ts`**, so the code is unreachable at runtime and exercised only by tests. "Katana" is **Katana Perps**, a perp DEX on the Katana chain built by the IDEX team, whom Katana acquired in March 2026. Drop the adapter, but keep its `TokenBucket` and backoff for Hyperliquid.
9. **Code bugs** (all verified against live shapes today):
   - **Scan position side:** `scan.ts` sets the side with `Number(p.positionSide) === 2`, but the API returns `"BOTH"`, so every position shows as SHORT.
   - **Scan PnL/liq fields:** it reads `unrealizedProfit`, `liquidationPrice` and `isolatedMargin`, which `/positions` does not have. The terse `state.P` does have `ur` and `lp`.
   - **Scan spot prices:** `/api/scan/prices` reads `lastPrice`, but tickers carry `lastPx`.
   - **Leaderboard page size:** `leaderboardMap` sends `pageSize`, which the API ignores. It works only because the default is 20.
   - **Weight table:** `weightFor` defaults to 5 where the docs say 20, and ignores the klines extra weight.
   - **Browser signer (unwired):** `web/src/signing.ts` compares an expiry in ms against seconds, and `read()` accepts HTTP-200 error envelopes as data.

   **Stale docs:**
   - The test count is **198 passing**, not 98 (NOTES.md) or 189 (README).
   - DEPLOYMENT.md's CORS claim is wrong (see item 6).

---

## 1. What Opentrade is, in one paragraph

Opentrade is a localhost SoDEX trading terminal: a Fastify backend on `127.0.0.1:8787` and a Vite/React frontend on `:5173`. The backend holds an in-memory `TRADE|CANCEL` (mask 3) delegated API key, minted from one master-wallet EIP-712 signature. It signs orders server-side, proxies and caches public market data under a single global weight budget, and fans one upstream WS per engine out to browser tabs. It walks full account history into SQLite for all-time stats, and builds unsigned deposit calldata for ValueChain. Money movement uses a separate single-use "elevation" key per operation. Everything is designed around **one user on one machine**, and DEPLOYMENT.md says explicitly not to host it as-is. See `DEPLOYMENT.md:96-137`.

## 2. Per-file reuse map

Legend: ✅ reuse as-is · 🔧 port (keep logic, adapt the wiring) · ♻️ rewrite (same job, new design) · ❌ drop · — not relevant.

### 2.1 `server/src` (root)

| File | Purpose / key functions | Verified vs guessed | (a) Indexer | (b) Read API | (c) Executor | (d) Browser |
|---|---|---|---|---|---|---|
| `config.ts` (106 lines) | `NETWORKS` (mainnet 286623 `https://mainnet-gw.sodex.dev`, `wss://…`; testnet 138565), `.env` loader, `HOST=127.0.0.1`, `ALLOW_MAINNET_WRITES`, `enginePath()`/`wsPath()` | Hosts and chain IDs verified live | 🔧 keep the network table only | 🔧 same | 🔧 same | 🔧 same |
| `index.ts` (348) | Fastify bootstrap; global error mapping (`SodexApiError`→hint); `onRequest` origin + local-token gate + write rate-limit; `/ws` upgrade; env-key bootstrap that reads the key's real permission mask from `/api-keys` | Origin/token behaviour verified by the author (NOTES.md:43) | ♻️ | ♻️ (keep the error-shaping idea and headers `nosniff`/`DENY`/`no-referrer`/`no-store`) | ♻️ (keep "read the permission mask from the exchange, never assume": `index.ts:275-295`) | — |
| `decimal.ts` (145) | `canonicalDecimal` (Go `shopspring/decimal` byte-compatible, never exponent notation), `roundToStep`, `decimalCompare`, `numberToPlainString` | Verified via Go vectors (`perps_tiny_price`) | ✅ | ✅ | ✅ | ✅ (already imported via `@sign`) |
| `history.ts` (1159) | Backward pager `walkBackwards`, normalisers `normaliseTrade`/`normaliseFunding`, exact `DecimalSum`, per-coin aggregation `aggregateTrades`/`aggregateFunding`, SQLite cache (`rows_`, `sync_state`), two-phase `syncScope` (catch-up + extend), `ensureSync` | Pager rules measured live (see §3.1); row shapes verified again today | 🔧 **core of the backfill worker**; ♻️ storage and job control | 🔧 aggregation functions | — | — |
| `hub.ts` (226) | Browser fan-out: refcounted per-client subs, per-client symbol filtering of array channels, snapshot replay to late joiners, `MAX_SUBS_PER_CLIENT=512` | Channel behaviour verified by the author; **account routing is broken for more than one user per upstream** (verified today, §3.4) | ❌ (use a firehose consumer instead) | 🔧 market-data fan-out only (SSE/WS), drop account channels | — | ❌ (browser subscribes to SoDEX directly for its own account) |
| `elevation.ts` (393) | Just-in-time fund-moving key: `prepareElevation` → wallet signs → `completeElevation` arms a 180 s single-use key → `consumeElevation` checks `ElevationIntent` (scope/engine/coin/amount/dest) and revokes; `revokeAllElevations` on shutdown | Logic unit-tested (16 tests); **never exercised end-to-end** (NOTES.md:112-124) | — | — | ❌ **the executor must never hold transfer/withdraw bits** | 🔧 port the *pattern* into the browser: mint an in-tab key with WITHDRAW or TRANSFER, sign one `transferAsset`, revoke |
| `keys.ts` (18) | `generateKey()` secp256k1 | Trivial | — | — | 🔧 (generate inside KMS/enclave instead) | ✅ (`web/src/signing.ts:generateSessionKey` already exists) |
| `keystore.ts` (318) | AES-256-GCM + scrypt multi-account keystore; now only a legacy migration path (nothing writes) | Tested | — | — | ♻️ (use KMS envelope encryption for follower keys) | ❌ |
| `deviceKey.ts` (77) | 32-byte device secret in `%LOCALAPPDATA%` | Tested | ❌ | ❌ | ❌ | ❌ |
| `localToken.ts` (82) | Loopback shared-secret header `x-valuetrade-token`, injected by the Vite proxy | Tested | ❌ | ❌ (replace with SIWE sessions) | ❌ | ❌ |
| `origin.ts` (28) | URL-parsed loopback origin allow-list | Tested | — | 🔧 (make the allow-list configurable) | — | — |
| `rateLimit.ts` (69) | Fixed-window **global** counters: writes 300/min, money 12/min | Tested | — | ♻️ per-IP/per-user (or at the edge) | ♻️ per-follower | — |

### 2.2 `server/src/sodex`

| File | Purpose / key functions | Verified vs guessed | (a) | (b) | (c) | (d) |
|---|---|---|---|---|---|---|
| `rest.ts` (704) | `SodexClient`: envelope success assertion (`code===0` or else fail; `rest.ts:594-603`), `unwrapList`, allow-list retry `isTransientFailure` (GET only, 4 attempts, equal-jitter backoff), `weightFor`, `WeightBudget` (1200/60 s, 30 s max wait), `TtlCache` with in-flight coalescing, multi-session map, global monotone `nextNonce`, `signed()` (reserve weight → allocate nonce → sign → send with no `await` in between), `relay()` for wallet-signed actions | Envelope and 8% error-page behaviour observed by the author; weights partly documented, partly measured | 🔧 **transport core**; make the budget per-egress-IP, shared across workers (Redis), fix the weight table (§6) | 🔧 read-through cache | 🔧 signed path per follower key (one key per follower ⇒ one nonce tracker each) | 🔧 already partly ported in `web/src/signing.ts`; add the envelope assertion |
| `ws.ts` (292) | `Upstream`: one socket per engine, `{"op":"ping"}` every 30 s, reconnect 250 ms→8 s with jitter, resubscribe-on-open, refcounted `(channel, params)` subs, snapshot cache; `CHANNEL_PARAM_STYLE` (verified 8-channel matrix), `normaliseSubParams`, `subKey`, `routeKeys` | Matrix verified by the author on testnet; `trade` with `symbols:[98]` verified today on mainnet | ✅ for the firehose socket (drop `lastSnapshot` for `trade`) | 🔧 | 🔧 same class for leader-fill detection | ♻️ browser version already in `web/src/ws.ts` (talks to the hub; repoint to SoDEX) |
| `chain.ts` (663) | ValueChain RPC (`rpc`, `ethCall`), `registration()` via `getUserId` `0x2b956ff7`, **`resolveAccountOnChain(id)`** via unnamed selector `0x792713b8` + round-trip `getAccountsByAddress` `0x380e78af` + corroboration from `sodex.dev/{net}/chain/user/{id}/address`; deposit calldata `encodeDeposit`/`encodeApprove`, `simulateDeposit`, `depositRegistry` (SoDEX `tradable-tokens` ⋈ Blockscout ⋈ gateway coins), `CONTRACT_ERRORS` map | id→owner verified today (52599 → `0xe290…cb67` on all three sources); deposit calldata byte-matched to a mainnet tx (test) | ✅ **id→address resolver** (last-resort tier) | ✅ | ✅ `registration()` for onboarding checks | 🔧 deposit builders are pure and could move to the browser (RPC CORS unverified) |
| `mirrorRegistry.ts` (145) | ValueChain mirror registry `0xB37295d1…70CB`: `getDepositWallet(account, chain)`, `listRemoteNativeTokens()` ABI decoding | Verified by the author (address reproduced) | — | 🔧 (deposit UX) | — | 🔧 |
| `symbols.ts` (193) | Symbol cache (60 s), `resolve()` by name/display/id, **`normaliseOrder()`** (tick/step snapping, min/max qty, notional, funds checks), `mulDecimal`, `coins()` | Symbol shapes verified today (98 perps / 43 spot / 48 coins) | ✅ | ✅ | ✅ **validate every copied order before signing** | ✅ |

### 2.3 `server/src/signing`

| File | Purpose / key functions | Verified vs guessed | (a) | (b) | (c) | (d) |
|---|---|---|---|---|---|---|
| `eip712.ts` (238) | Domain (`spot` / `futures` / `universal`, version `1`, verifyingContract 0x0), `ExchangeAction(bytes32 payloadHash,uint64 nonce)`, `goJSONStringify` (Go `encoding/json`, including HTML escaping), `signDigest` → 66-byte wire sig `[type][r][s][v∈{0,1}]`, `signExchangeAction`, `recoverAddress`, `privateKeyToAddress` | **19 Go-SDK vectors, 34 assertions**; testnet gateway accepted the sig layer (NOTES.md:17-20) | — | — | ✅ | ✅ |
| `actions.ts` (269) | Builders in Go struct field order: `perpsNewOrder`/`buildRawOrder`, `perpsCancelOrder`, `perpsModifyOrder`, `perpsUpdateLeverage`, `perpsUpdateMargin`, `spotBatchNewOrder`, `spotBatchCancelOrder`, `replaceOrder`, `transferAsset` (magic `CROSS_ENGINE_ACCOUNT_ID=999`), `scheduleCancel`, `revokeAPIKey`; enums (`OrderSide`, `TimeInForce` incl. `GTX`=4, `APIKeyPermission` TRADE 1/CANCEL 2/WITHDRAW 4/TRANSFER 8), `CL_ORD_ID_RE` | Vector-verified | — | — | ✅ + **add `builder`** (last field; perps per-order *and* batch default; spot batch-level after `orders`; `id` before `fee`; docs: builder-codes.md:109-124) and regenerate vectors | ✅ + same |
| `userSigned.ts` (194) | `UserSignedAddPermissionedAPIKeyAction` typed data (domain `universal`, chainId = the **wallet's** chain; message `chainID` = SoDEX chain), body builder, `walletSignatureToWire` (v 27/28 → 0/1, prefix `0x02`) | Vector-verified; gateway accepted the sig on testnet (Aug 2026) | — | — | 🔧 add `AddAPIKeyWithBuilder` and `ApproveBuilderFeeAction` (type strings documented, builder-codes.md:78-80) | 🔧 same; also `AddAPIKey` (docs now register at `POST /api/v1/user/{addr}/api-keys`) |

### 2.4 `server/src/routes`

| File | Purpose | Verified vs guessed | (a) | (b) | (c) | (d) |
|---|---|---|---|---|---|---|
| `account.ts` (136) | `/api/acct/:engine/{state,balances,orders,orders/history,trades,fee-rate,api-keys}`, `/api/acct/perps/{positions,funding-history→/fundings}`; `historyQuery` clamps limit ≤1000 and passes it to `weightFor` | Shapes verified today | 🔧 as the "live overlay" fetcher | 🔧 read-through with a short TTL | — | ✅ browser can call the gateway directly (CORS `*`) |
| `market.ts` (78) | `/api/md/:engine/{symbols,coins,tickers,bookTickers,mark-prices,orderbook,klines,trades}`; interval allow-list | Verified | — | 🔧 (only if serving cached data to many users) | — | ✅ direct |
| `trade.ts` (361) | Place (perps entry + reduce-only TP/SL legs in one signed batch; spot via batch endpoint; refuses spot triggers), cancel, cancel-all (lists open orders then cancels), modify, replace, leverage, margin, schedule-cancel | Payloads vector-verified; **no real order ever placed** (NOTES.md:112-126) | — | — | 🔧 **order assembly for the executor** | 🔧 move to the browser on top of `signedWrite` |
| `money.ts` (349) | Elevate/complete, cross-engine transfer (999), internal transfer, withdraw (`toAccountID:0`, unverified), `resolve-destination` | Not executed end-to-end (TODO.md) | — | — | ❌ | 🔧 browser elevation |
| `wallet.ts` (762) | Session list/lock/active, legacy keystore migration, import, `/api/wallet/{account,permissions,apikey/prepare,apikey/complete,enable,apikey/revoke}`: **server generates key → returns typed data → wallet signs → server relays to `/api/v1/{engine}/accounts/api-keys`** | `expiresAt` is **milliseconds** (proven from live keys, `wallet.ts:55-77`); relay path signature-verified on testnet | — | — | 🔧 **this prepare/complete flow is exactly how a follower delegates a key to the executor** | ♻️ generate in the tab (already in `web/src/signing.ts`) |
| `deposit.ts` (256) | Chain info, asset list, `prepare` (unsigned approve+deposit calldata, on-chain symbol/decimals re-check, `eth_call` dry run), tx status | Calldata byte-matched to mainnet | — | 🔧 | — | 🔧 |
| `mirror.ts` (228) | Cross-chain deposit options: `alpha-biz /biz/config/symbol` whitelist ∩ `POST /biz/mirror/create_deposit_addresses` ∩ on-chain `getDepositWallet` re-derivation | Verified by the author; the docs now also list `POST /api/v1/user/{addr}/deposit-address(es)` (weight 200) | — | 🔧 | — | 🔧 |
| `onboarding.ts` (145) | Four gates: wallet / registered (`getUserId`) / key / funded | Verified | — | 🔧 | — | 🔧 |
| `pointsAuth.ts` (120) | Proxies `sodex.com/auth/v2/{nonce,verify}` **with `Origin: https://sodex.com` set server-side** to get past SoDEX's CORS allowlist | Verified by the author | — | ❌ (DEPLOYMENT.md:175-191: hosting this means handling users' SoDEX JWTs and impersonating their origin) | — | ♻️ only if SoDEX allowlists Valuescan's origin |
| `external.ts` (516) | `/api/external/leaderboard` (enum-validated: windows `24H/7D/30D/ALL_TIME`, `sort_by pnl/volume`, `page_size ∈ {10,20,50}`), `/leaderboard/rank`, `/resolve-account`, `/maintenance/status` (NORMAL vs anything else, plus any recent 503 from any SoDEX host), `/announcements` (+detail with `htmlToText`, dropping the always-zero `startTime`/`endTime`) | Enums verified today (`page_size=100` → 400) | 🔧 leaderboard crawl source | ✅ port nearly as-is | — | — |
| `stats.ts` (266) | `/api/stats/all-time`: kicks `ensureSync` for 3 scopes, answers at once from cache + progress; merges the venue "headline" from `mainnet-data /perps/pnl/overview` + `/daily_stats` (perps-only, UTC-midnight snapshot); `spotRealizedPnl: null` with reason | Headline shapes verified today; `/spot/pnl/overview` 404 verified | 🔧 | 🔧 **the provenance-labelled response design is worth keeping** | — | — |
| `scan.ts` (483) | Legacy backend for the old static Scan page: `/api/scan{,/trades,/funding,/prices,/feerates,/windows,/live,/feeschedule,/track*}`, `/api/feed/account`; depends on third-party `communityscan-sodex.com/api/public/wallet/{addr}`; `leaderboardMap()` (top 500, 10 min TTL); in-memory tracker (max 6 wallets) | **Web no longer calls `/api/scan/*`**. Only `/api/feed/account` is used (`App.tsx:47`); several field bugs (§7) | 🔧 salvage `leaderboardMap` (fix the param) and the resolver order LB → on-chain | ❌ mostly; ❌ CommunityScan dependency | — | — |
| `venues.ts` (142) | `/api/venues/*` multi-venue market data, plugin-scoped error handler | **Not registered in `index.ts`** (dead at runtime) | — | 🔧 if a multi-venue market API is needed | — | — |

### 2.5 `server/src/venues` — the venue abstraction and "Katana"

| File | Purpose | (a) | (b) | (c) | (d) |
|---|---|---|---|---|---|
| `types.ts` (234) | `Venue` interface with **5 read-only methods**: `symbols`, `tickers`, `orderbook(depth per side)`, `trades` (newest first, `takerSide` = aggressor), `candles` (oldest first). Normalisation rules: decimals stay strings, missing means `null` never 0. Helpers `decStr`, `numOrNull`, `clampLimit`, sorters | 🔧 seed of the multi-venue interface, but it must grow account-level methods (fills, positions, funding, equity) for SoDEX and Hyperliquid | 🔧 | — | — |
| `sodex.ts` (261) | SoDEX adapter over the shared `SodexClient` (two venues: `sodex-perps`, `sodex-spot`); normalisers for ticker (`lastPx`…, `changePct` already in percent), book (`updateID`, `blockTime`), trade (`S` = aggressor), kline | ✅ | ✅ | — | — |
| `katana/index.ts` (282), `katana/rest.ts` (362) | **Katana Perps** (`https://api-perps.katana.network`; the documented `perps-api.` host has no DNS). Read-only by decision (writes need API key + HMAC + EIP-712). Measured 5 req/s bucket, run at 4/s; `TokenBucket` that tolerates debt; backoff with a 1 s base for 429s; `makerSide` inverted to taker; book `limit` counts both sides | ❌ venue not in scope; ✅ **reuse `TokenBucket` and `katanaBackoffMs` for Hyperliquid's REST budget** | ❌ | — | — |

What "Katana" is: Katana is a DeFi chain whose perp DEX, **Katana Perps**, was built by the IDEX team after Katana acquired IDEX (announced 2026-03-23). It uses an off-chain order book with on-chain settlement and `vbUSDC` collateral. The API shape (`/v1/markets`, `fillId`, `makerSide`, HMAC-plus-wallet writes) is IDEX-style. In Opentrade it comes from the owner's older multi-bot dashboard, a "sodex/apex/katana" fleet (`web/public/scan/cmdk.js:188-191`), and the web app never calls it. Sources: [GlobeNewswire](https://www.globenewswire.com/news-release/2026/03/23/3260490/0/en/katana-acquires-idex-to-launch-katana-perps-bringing-native-perpetual-futures-to-its-defi-chain.html), [Katana docs](https://docs.katana.network/katana/core-concepts/katana-perps/), [docs-perps.katana.network](https://docs-perps.katana.network/).

### 2.6 `web/src` (backend-relevant)

| File | Data source | Notes | (a) | (b) | (d) |
|---|---|---|---|---|---|
| `signing.ts` (289) | **Browser signing straight to `mainnet-gw`**: `setSession`, Web-Locks nonce `withNonce` (lock `vt.nonce`, high-water mark in `localStorage` `vt.nonce.hwm`), `signedWrite`, `read`, `generateSessionKey`, `selfTestAgainstGoSdk` (embeds the `perps_limit_order` vector) | **Not imported anywhere**. Bugs: `isExpired()` compares ms `expiresAt` with seconds (`signing.ts:88`), so it never expires locally; `read()`/`signedWrite()` return `body.data ?? body` without checking `code` (`signing.ts:174`) | — | — | ✅ **after fixing both** |
| `performance.ts` (299) | Browser-direct: `mainnet-data /api/v1/wallet/portfolio/chart?account_id&window(24H/7D/30D/90D/1Y)&market_type(all/perps/spot)`; `alpha-biz POST /biz/mirror/account_flow` + `POST /biz/mirror/v2/combined_transfers` (100 rows/page, deduped by txHash); `/biz/soso_airdrop/claim_status`; `fetchAccountId` from gateway state | Chart shape verified today (no `ALL` window: 400) | 🔧 **cheap per-trader equity/ROI series** (1 call per account per window) | 🔧 | ✅ |
| `risk.ts` (251) | Pure maths: tiered maintenance margin from symbol `marginTiers`, `estimateLiquidationPrice`, `checkStopAgainstLiquidation`, `assertTierContinuity` | Formula derived; labelled as an estimate | — | ✅ (risk columns on Explore) | ✅; also 🔧 into executor pre-trade checks |
| `points.ts` (919) | `alpha-biz /biz/sopoints/{week/info,summary,week/list}` (summary/list need a bearer token), `/biz/referral/public/referralCode`; `mainnet-data /api/v1/leaderboard{,/rank}` (+`90D` window on rank), `/api/v1/dashboard/{volume,open-interest,tvl,users}` | Partly verified | 🔧 venue KPIs (volume/OI/TVL/users) | 🔧 | ✅ |
| `scanChain.ts` (193) | Blockscout `main-scan.valuechain.xyz/api/v2/addresses/{a}/token-balances` (bare array), `/addresses/{a}`, `/addresses/{a}/counters`; prices from spot `*_vUSDC` tickers (`lastPx`) | Explorer `exchange_rate` always null (author) | — | 🔧 | ✅ |
| `accountFeeds.ts` (211) | Refcounted shared polling per `(resource, engine, address)` key, 1.5 s eviction grace, debounced WS-triggered refresh `bumpAccountResource` | Author measured the dedup | — | — | ✅ |
| `components/Leaderboard.tsx` (282) | `/api/external/leaderboard` + `/rank` (backend proxy of `mainnet-data`) | Shows `snapshot_ts`; page sizes 10/20/50 | — | 🔧 Valuescan should serve its **own** ranking (copy metrics), with SoDEX's as the "venue" view | 🔧 UI |
| `components/Stats.tsx` (574) | `/api/stats/all-time` (walk + venue headline) | Provenance per number; per-coin fees | — | 🔧 | 🔧 UI |
| `ws.ts` | Browser hub client (refcount, reconnect, re-arm) | Talks to `/ws` hub | — | — | 🔧 repoint to `wss://mainnet-gw.sodex.dev/ws/{engine}` for own-account channels |

---

## 3. Deep dives

### 3.1 `history.ts`: how history, stats and the SQLite cache work

**The pager (`walkBackwards`, `history.ts:302-425`).**
- It requests `?endTime=&limit=1000` and repeats with `endTime = min(time)` of the last page. The bound is **inclusive** (`history.ts:421`), because same-millisecond fills are common.
- Rows re-delivered at the boundary are removed by a `seen` set keyed on a **SHA-1 of the whole raw row** (`rowId`, `history.ts:197`). The author measured `tradeID` as not unique: 989 distinct IDs across 1000 fills.
- **Termination:** an empty page means complete. A page shorter than `limit` that adds **zero new rows** also means complete. A full page stuck on one millisecond (the stall guard), a missing timestamp, or `MAX_PAGES=1000` means **truncated** and is never reported as complete.
- The optional `floorTime` ends the incremental catch-up.
- **Every page failure throws.** The walk never turns an error into "end of history". Together with `SodexClient.send`'s rule that a body must assert `code:0` (`rest.ts:594-603`), this is what stops the "~8% of history pages come back HTTP 200 with `{code:-1,error:"internal server error…"}`" failure from silently truncating totals. That failure rate was observed by the author (`rest.ts:96-104`).

**Page sources.**
- `tradePage(engine, address)` calls `/api/v1/{engine}/accounts/{addr}/trades` and unwraps under the key `trades`.
- `fundingPage(address)` calls `/api/v1/perps/accounts/{addr}/fundings`. The documented `/funding-history` returns 404.
- Weight is passed explicitly as `20 + limit/20`, which is 70 for a 1000-row page.

**The sync job (`syncScope`, `history.ts:975-1115`).**
- There are 3 scopes per address: `trades-spot`, `trades-perps`, `funding`.
- *Phase 1 (catch-up)* walks down from now to the last known `newest` with `startTime=newest`. Rows are saved per page, but `newest` only advances when the phase completes, so no hole is ever recorded as covered.
- *Phase 2 (extend)* resumes from `oldest` and checkpoints after every page, which is safe because the descent is contiguous.
- `complete` is set only when phase 2 reaches the real end.
- `ensureSync` re-arms after `RESYNC_AFTER_MS = 5 min`, or at once on a recorded error or truncation. Jobs are tracked in-process (`inFlight`, `running` Maps).

**Storage.**
- `node:sqlite` (Node 24 built-in, zero dependencies) at `%LOCALAPPDATA%\Valuetrade\stats-cache.db`, overridable with `VALUETRADE_STATS_DB`.
- Tables: `meta(schema)`, `rows_(scope, id, time, symbol, side, price, qty, quote, fee, fee_coin, is_maker, raw, PK(scope,id))` plus index `(scope,time)`, and `sync_state(scope, oldest, newest, complete, pages, updated_at, last_error)`.
- Rows are written in one transaction per page.
- `SCHEMA_VERSION` bumps wipe the cache.

**Aggregation.**
- `aggregateTrades` buckets fees **by fee coin**. Spot BUYs are charged in the base coin and SELLs in vUSDC, so summing them in "$" is refused.
- Notional is `mulDecimal(price, qty)`, labelled `derived`, because fills carry no quote quantity.
- It also produces a maker/taker split (from `isMaker`) and `bySymbol` totals.
- `aggregateFunding` sums `fundingFee` with the venue's own sign.
- There is **no realized PnL computation** for spot, by design.

**Measured on the owner's own cache** (a read-only copy in the scratchpad, verified):

| Scope | Rows | Span | Avg raw JSON |
|---|---|---|---|
| trades-spot (a bot account) | 305,454 | 2025-10-31 → 2026-06-12 | 217 B |
| trades-perps (same) | 40,171 | 2025-11-20 → 2026-03-31 | 207 B |
| funding (same) | 2,599 | | 138 B |
| second address, all scopes | 845 | 2026-06 → 2026-08 | |

In total that is 349,069 rows in a **231 MB** file, about **660 B/row on disk**, including the duplicated raw JSON and the index. The busiest perps day was 4,266 fills. An older 536 MB copy still sits inside the OneDrive folder at `server/.stats-cache.db`.

**Verdict for (a).** Port `walkBackwards`, `normaliseTrade`, `normaliseFunding`, `rowId`, `DecimalSum` and the aggregation functions as a library. Replace SQLite with the chosen store: don't keep `raw`, store typed columns, and compress, which should reach about 20–40 B/row in a columnar format (inferred). Replace `ensureSync` with a durable job queue with per-account leases. Add `positions/history` as a fourth scope; it exists and returns closed positions with `realizedPnL` (verified, §4).

### 3.2 `routes/stats.ts`: the two sources and why they stay apart

- **"Our walk":** exact, per-coin, and complete only when `sync.complete` says so.
- **"Venue headline":** `GET mainnet-data.sodex.dev/api/v1/perps/pnl/overview?account_id=` returns `{account_id, ts_ms, cumulative_pnl, cumulative_quote_volume, unrealized_pnl, first_trade_ts_ms}`. `ts_ms` is a UTC-midnight snapshot; I verified `1790294400000` = 2026-09-25T00:00Z. The curve comes from `…/perps/pnl/daily_stats?account_id=` → `{items:[{ts_ms, pnl}]}`, which is cumulative (220 points for account 52599).
- The route needs `aid` first. It gets it from gateway `state.aid`, a weight-5 call; `aid = 0` means there is no account.

For Valuescan, the headline endpoints plus `wallet/portfolio/chart` (§2.6) give **free precomputed perps PnL/ROI per account**. That is useful for ranking before our own reconstruction exists. Its limits: perps only, and a daily cadence for `pnl/*`.

### 3.3 `routes/scan.ts` and `routes/external.ts`

- `external.ts` is clean and small. Port it nearly unchanged for (b). Its enum validation (`page_size ∈ {10,20,50}`, windows) was verified again today.
- `scan.ts` is a port of another dashboard's `adapters.py`. Its only live consumer is `/api/feed/account`, the id→address lookup used by the trade tape. Its resolver order is right: the leaderboard map (authoritative for listed accounts) first, then the on-chain resolver.
- Everything else in `scan.ts` is superseded by the in-app Scan (`web/public/scan/index.html` is now just a redirect). It also has the field bugs in §7.
- It depends on a **third-party** host, `https://www.communityscan-sodex.com/api/public/wallet/{addr}`, which Valuescan should not rely on.

### 3.4 `sodex/ws.ts` + `hub.ts`: fan-out, the channel matrix, and what breaks at scale

**Verified channel parameter matrix** (`ws.ts:36-55`):

| Channel | `symbol` | `symbols[]` | none |
|---|---|---|---|
| trade | error | ok | error |
| l2Book | ok | error | error |
| candle | ok | error | error |
| ticker | error | ok | error |
| bookTicker | error | ok | error |
| markPrice | error | ok | error |
| allTicker | ok | ok | ok |
| allMarkPrice | ok | ok | ok |

Account channels (`accountOrderUpdate`, `accountTrade`, `accountUpdate`, `accountState`) take `user`.

**Today's probes** (mainnet, read-only):
- One socket accepted `trade` with **all 98 perps symbols**, plus 5 `accountTrade` users, plus `accountState`, `accountOrderUpdate` and `allMarkPrice`. That produced **106 acks, 0 failures**; `trade` acks once **per symbol**.
- **`trade` pushes** `{E, T, t, s, S, p, q, bi, si}`. Every one of 516 prints had `bi` and `si` (buyer and seller account id). `S` is the aggressor, so `S=BUY` means `bi` is the taker.
- **`accountTrade` pushes** carry `data: [{E, T, t, s, i, c, S, p, q, f, m, d}]` and **no `user`** (the subscribe *ack* carries `user` and `accountID`). `accountOrderUpdate` also has **no `user`**. `accountState` does carry `user` and `aid`.
- Consequently `routeKeys()` and `HubClient.deliver()` (`hub.ts:150-155`: `if (want && got && want !== got) continue;`) pass **every** `accountTrade`/`accountOrderUpdate` push to every client subscribed to that channel once two users share an upstream. With one user on localhost this is harmless. In a hosted relay it misattributes fills.
- The docs cap one IP at **10 WS connections, 30 new per minute, 1000 subscriptions, 10 unique users, 2000 messages/min per IP and per connection, 100 inflight** (`developers_trading_api-rate-limits.md`). **Per-account channels cannot track thousands of accounts.** The `trade` firehose uses 98 + 43 = 141 subscriptions for both engines and covers everyone.

**Keep from `ws.ts`:**
- keep-alive `{"op":"ping"}` every 30 s (the code says the gateway drops after 60 s of silence);
- jittered reconnect;
- resubscribe on open;
- `normaliseSubParams`.

Drop `lastSnapshot` caching for `trade`. Also note that the firehose has gaps during reconnects, which the REST walk must fill (§8).

### 3.5 `sodex/rest.ts`: weight budget and `unwrapList`

**Envelope rule.** Accept a body only when `code === 0`. Otherwise a non-zero `code`, an error/message string, or a missing `data` means **throw**. An empty 2xx body is treated as an ack for writes.

**`unwrapList(data, key)` normalises shapes.** Verified today:
- **Wrapped** `{blockTime, blockHeight, <key>: [...]}`: `balances`, `orders` (open), `positions`, and the orderbook (`{blockTime, blockHeight, updateID, bids, asks}`).
- **Bare arrays**: `trades`, `orders/history`, `fundings`, `positions/history`, all `markets/*` lists, `klines`, and public `trades`.

The author found that cancel-all used to "succeed" on the wrapped shape while cancelling nothing.

**Retry.**
- GETs only: 4 attempts, equal-jitter backoff at a 250 ms base and 4 s cap.
- Allow-list only: ≥500, 429, `code≠0` under HTTP 2xx whose text matches `internal error|unavailable|timeout|…`, and network TypeError/Abort.
- Writes are **never** retried, because of the double-fill risk.

**Weight budget.**
- `WeightBudget(1200, 60 s)`, a single global instance, with a 30 s maximum wait before rejecting.
- The docs say **1200 weight/min per IP**.
- The live gateway (Cloudflare) returns `x-ratelimit-limit: 6000`, `x-ratelimit-remaining`, and `x-ratelimit-reset` (epoch seconds, 1-minute window) (verified). The unit, requests or weight, could not be isolated because parallel agents shared the IP. **Both limits exist**, and a hosted indexer must honour the lower documented one until measured.
- These headers are **not** exposed through CORS (`access-control-expose-headers: Content-Length`), so browsers cannot read them.

**`weightFor` compared with the docs** (fix these):

| Path | `weightFor` | Docs |
|---|---|---|
| unlisted paths (e.g. `/user/{a}/ratelimit`) | 5 | **20** default |
| klines | 20 | 20 + max(1, rows/25) |
| orderbook > 500 | 10 | **20** |
| history | 20 + limit/20 (billed up front) | 20 + items/20 **after** the response |
| batch orders | 1 | 1 + floor(N/40) |
| transfers | 1 | 10 |

**Nonces.**
- `nextNonce()` gives one global, strictly increasing millisecond counter across all keys.
- `signed()` reserves weight *before* allocating the nonce, so wire order equals nonce order.
- The docs now say the **100 highest nonces per signing address** are kept; a new nonce must be larger than the smallest of them and never used before, inside the window (T−2d, T+1d).
- So strict ordering is **stronger than required** and the multi-tab problem in DEPLOYMENT.md mostly dissolves. This is documented, not verified by a write.

### 3.6 `sodex/chain.ts`: account id ↔ address, and the mirror registry

**address → id**, cheapest first:
- gateway `GET /api/v1/{engine}/accounts/{addr}/state` → `aid`, `uid` (weight 5);
- `https://sodex.dev/mainnet/chain/address/{addr}/accounts` → `{address, userId, primaryAccountId, subAccountIds[]}` (verified);
- on-chain `getUserId(address)` `0x2b956ff7` on `0x0101…0101`, which reverts `0x40298ab1` if the address is unregistered.

**id → address**:
1. The **leaderboard** (`account_id` and `wallet_address` on every row; 134,605 rows).
2. `https://sodex.dev/mainnet/chain/user/{id}/address` → `{userId, address}` (verified; CORS reflects the origin).
3. On-chain `0x792713b8(uint256 id)` → owner, round-tripped through `getAccountsByAddress` `0x380e78af`. Verified today: `52599 → 0xe290…cb67` on all three.

`resolveAccountOnChain` fails closed on disagreement and caches for 1 h. For an indexer that must resolve thousands of `bi`/`si` ids: crawl the leaderboard once, then use `sodex.dev` for misses, then fall back to RPC `eth_call` (JSON-RPC batching is possible, but its rate limits are unknown).

Other on-chain pieces:
- ValueChain head block was 0xe19923 = 14,784,803 (verified).
- The **mirror registry** (`mirrorRegistry.ts`) at `0xB37295d1ea21E65b76dCB2E85e035eE0dBFC70CB` exposes `getDepositWallet(address,string)` and `listRemoteNativeTokens()`, a tuple of 7 fields. It only matters for deposit UX, not indexing.

### 3.7 `signing/*`: EIP-712 builders and test vectors

- **Vectors.** `server/test/vectors.json` holds 19 vectors, generated by `server/tools/genvectors.go` from a checkout of `sodex-tech/sodex-go-sdk-public` (test key `0x4c08…2318`, testnet 138565). The command is `go run ./tools/genvectors > vectors.json`.
- **Covered actions:** perps limit, market reduce-only, stop-loss, tiny price, multi-order, cancel, modify, leverage, margin, transfer→spot, schedule-cancel armed/cleared, spot batch new, spot market-by-funds, spot batch cancel, spot→perps transfer, replace, revoke key, and user-signed add-permissioned-key.
- `vectors.test.ts` asserts the canonical JSON, payload hash, body and 66-byte signature for each.
- **Missing for Valuescan:** `builder` on perps orders (per order and as a batch default) and on spot batches, `AddAPIKeyWithBuilder`, `ApproveBuilderFeeAction`, `AddAPIKey` (the new documented registration), and the new endpoint `POST /api/v1/user/{addr}/api-keys`. The Go SDK or the Python SDK must be checked for these struct field orders before writing vectors. The docs state that `builder` is the **last** field in its structure, with `id` before `fee`, and that `builder` and `permissions` are **mutually exclusive** in one registration request (builder-codes.md:93,122).

### 3.8 `elevation.ts`: the safety pattern

The resting key is `TRADE|CANCEL` (3). Every fund movement mints a second key whose mask is 3 plus exactly one of TRANSFER (8) or WITHDRAW (4):
- it lives 180 s at the gateway (`expiresAt` in ms) and in memory;
- it is single-use and bound to an exact `ElevationIntent`;
- it is revoked after use, on mismatch, on expiry, and on shutdown.

For Valuescan the **executor must hold mask-3 keys only**. The elevation pattern belongs in the browser for the user's own transfers and withdrawals.

---

## 4. SoDEX endpoint and channel inventory (the indexer's source list)

Gateway base: `https://mainnet-gw.sodex.dev` (Cloudflare, FRA edge from DE). All account reads are **unauthenticated for any address**. REST responses are `{code, data, timestamp}`; treat `code≠0` as failure even under HTTP 200. Weights come from the docs (`developers_trading_api-rate-limits.md`) unless marked.

### 4.1 REST: market data (`/api/v1/{spot|perps}`)

| Endpoint | Params | Auth | Shape (verified 2026-09-25) | Weight | Used by |
|---|---|---|---|---|---|
| `GET /markets/symbols` | – | none | bare array (perps 98, spot 43): `id, name, displayName, baseCoin(ID), quoteCoin(ID), pricePrecision, tickSize, minPrice, maxPrice, quantityPrecision, stepSize, minQuantity, maxQuantity, marketMin/MaxQuantity, minNotional, maxNotional, makerFee, takerFee, status`, perps: `maxLeverage, openInterestCap(USD), fundingInterval, marginTiers[]` | 2 | symbols.ts (60 s cache) |
| `GET /spot/markets/coins` | – | none | bare [48] `{id, name, precision}` | 2 | symbols.ts, chain.ts |
| `GET /markets/tickers` | – | none | **bare** array: `symbol, lastPx, lastSz, openPx, highPx, lowPx, volume, quoteVolume, vwap, change, changePct (number, already %), askPx, askSz, bidPx, bidSz, openTime, closeTime`; perps adds mark/index | 2 | market.ts (1 s cache), venues/sodex.ts |
| `GET /markets/bookTickers` | – | none | bare `{symbol, askPx, askSz, bidPx, bidSz}` | 2 | market.ts |
| `GET /perps/markets/mark-prices` | – | none | bare `{symbol, openInterest, markPrice, indexPrice, fundingRate, nextFundingTime}` | 2 | market.ts, scan.ts |
| `GET /markets/{symbol}/orderbook` | `limit` (per side) | none | **wrapped** `{blockTime, blockHeight, updateID, bids:[[p,q]], asks}` | 5 (≤100) / 10 (≤500) / 20 (>500) | market.ts |
| `GET /markets/{symbol}/klines` | `interval` ∈ {1m,3m,5m,15m,30m,1h,2h,4h,6h,8h,12h,1D,3D,1W,1M}, `limit≤1000`, `startTime`, `endTime` | none | bare `{t,o,h,l,c,v,q,n}`, **newest first** | 20 + max(1, rows/25) | market.ts |
| `GET /markets/{symbol}/trades` | `limit≤500` | none | bare `{t,T,s,S,p,q}`, **no `bi`/`si`** | 20 | market.ts |

### 4.2 REST: account reads (any address, no auth)

| Endpoint | Params | Shape quirks (verified) | Weight |
|---|---|---|---|
| `GET /{e}/accounts/{addr}/state` | – | perps: `{user, aid, uid, av, mm, mmr, am, ami, amw, im, cm, oim, ocm, B[], P[], O[], TO, S[]}`. Terse `P` = `{i, s, m, ps, sz(signed), ep, co, cf, cc, cp, ms, cr, ur(unrealised), l, lp(liq price), ct, ut}`, `S` = leverage settings `{s, l, m}`. spot: `{user, aid, uid, B[{i,a,t,l}], O, TO}`. `aid=0` ⇒ no account | 5 |
| `GET /{e}/accounts/{addr}/balances` | – | **wrapped** `balances`. perps `{id, coin, total, collateral, marginRatio, price}`, spot `{id, coin, total, locked}` | 5 |
| `GET /{e}/accounts/{addr}/orders` | `symbol?` | **wrapped** `orders` | 5 |
| `GET /perps/accounts/{addr}/positions` | – | **wrapped** `positions`: `id, symbol, marginMode("CROSS"), positionSide("BOTH"), size, initialMargin, avgEntryPrice, cumOpenCost, cumTradingFee, cumClosedSize, avgClosePrice, maxSize, realizedPnL, leverage, active, isTakenOver, takeOverPrice, createdAt, updatedAt`. **No uPnL / liq / mark**: use `state.P` | 5 |
| `GET /perps/accounts/{addr}/positions/history` | `limit≤1000` (accepted), time filters assumed | **bare**; closed positions: `positionSide "LONG"/"SHORT"`, `size "0"`, `avgEntryPrice`, `avgClosePrice`, `cumClosedSize`, `maxSize`, `realizedPnL`, `cumTradingFee`, `active:false`, timestamps. **Not used by Opentrade**; high value for win-rate and per-trade PnL | 20 + n/20 |
| `GET /{e}/accounts/{addr}/trades` | `startTime`, `endTime` (**inclusive**), `limit≤1000`, `symbol?` | **bare** `{symbol, tradeID (not unique), orderID, clOrdID, side, price, quantity, fee (negative = rebate), feeCoin, time, isMaker}`; the docs also mention `builderFee` on fills | 20 + n/20 |
| `GET /{e}/accounts/{addr}/orders/history` | same | **bare** `{symbol, orderID, clOrdID, side, type, timeInForce, price, origQty, status, executedQty, executedValue, marginFrozen, createdAt, updatedAt, positionSide, reduceOnly}` (string enums) | 20 + n/20 |
| `GET /perps/accounts/{addr}/fundings` | same | **bare** `{symbol, positionID, positionSide, fundingFee, feeCoin, timestamp}`; `/funding-history` (as documented) → 404 | 20 + n/20 |
| `GET /{e}/accounts/{addr}/fee-rate` | – | `{makerFeeRate, takerFeeRate, feeTier, stakingTier, makerRebateTier}` | 2 |
| `GET /{e}/accounts/{addr}/api-keys` | – | array `{name, type, publicKey, expiresAt(ms), permissions}` (leaks key names publicly) | 5 |
| `GET /api/v1/user/{addr}/api-keys` | – | `{spot:[…], perps:[…]}` (verified; not used by Opentrade) | 5 (assumed) |
| `GET /api/v1/user/{addr}/builders` | – | `{spot:[{builderID, feeRate}], perps:[…]}` (verified empty shape) | not listed; assume 20 |
| `GET /api/v1/user/{addr}/ratelimit` | – | `{userID, cumulativeTxNum, cumulativeCancelNum, cumulativeVolume, transactionQuota(=vol+10000), transactionQuotaUsed/Remaining/Overridden, cancelQuota(Used/Remaining)}` (verified) | 20 |

### 4.3 REST: signed writes (code only; none exercised against mainnet)

All carry the headers `X-API-Key` (key name), `X-API-Sign` (0x01 + r + s + v), `X-API-Nonce` (ms), and `X-API-Chain` (286623). The body is the exact `goJSONStringify(params)`.

| Endpoint | Action type | Weight | Opentrade route |
|---|---|---|---|
| `POST /perps/trade/orders` | `newOrder` (entry + reduce-only TP/SL legs) | 1+⌊N/40⌋ | trade.ts |
| `DELETE /perps/trade/orders` | `cancelOrder` | 1+⌊N/40⌋ | trade.ts |
| `POST /perps/trade/orders/modify` | `modifyOrder` | 1 | trade.ts |
| `POST /{e}/trade/orders/replace` | `replaceOrder` | 1+⌊N/40⌋ | trade.ts |
| `POST /perps/trade/leverage` | `updateLeverage` | 1 | trade.ts |
| `POST /perps/trade/margin` | `updateMargin` | 1 | trade.ts |
| `POST /{e}/trade/orders/schedule-cancel` | `scheduleCancel` (dead-man switch) | 1 | trade.ts |
| `POST /spot/trade/orders/batch` / `DELETE` | `batchNewOrder` / `batchCancelOrder` | 1+⌊N/40⌋ | trade.ts |
| `POST /{e}/accounts/transfers` | `transferAsset` (types 0–6; `999` = cross-engine) | 10 | money.ts |
| `POST /{e}/accounts/api-keys/revoke` | `revokeAPIKey` | – | wallet.ts, elevation.ts |
| `POST /{e}/accounts/api-keys` | wallet-signed `UserSignedAddPermissionedAPIKeyAction` (0x02, `universal` domain), relayed unsigned | – | wallet.ts, elevation.ts |
| `POST /api/v1/user/{addr}/api-keys` | `AddAPIKey` / `AddAPIKeyWithBuilder` (documented; registers both engines) | – | **not in Opentrade** |
| approve builder endpoint (public API section) | `ApproveBuilderFeeAction` | – | **not in Opentrade** |

Order-placement limits (docs): **600 orders/min and 20/s per account** with an API key, 60/min without a key. The address action quota is 1 request per 1 USDC traded since inception, plus a 10,000 buffer; once exhausted, 1 request per 10 s.

### 4.4 WebSocket (`wss://mainnet-gw.sodex.dev/ws/{spot|perps}`)

Client messages: `{"op":"subscribe"|"unsubscribe","params":{…}}` and `{"op":"ping"}`. Acks: `{op, success, result|error, connID}`.

| Channel | Params | Push payload (verified) | Opentrade use |
|---|---|---|---|
| `trade` | `symbols:[…]` (one ack per symbol) | `data:[{E, T, t, s, S, p, q, bi, si}]` (buyer/seller account ids) | tape + TapeFilter only |
| `l2Book` | `symbol`, `level?` | book | Market |
| `candle` | `symbol`, `interval` | kline (`data.i`) | Chart |
| `ticker` / `bookTicker` / `markPrice` | `symbols` | arrays of per-symbol entries | Market, Portfolio |
| `allTicker` / `allMarkPrice` | none | array; `allMarkPrice` `{E, s, oi, p, i, r, T}` | – |
| `accountState` | `user` | snapshot with `user`, `aid`, …, same as REST `state` | – |
| `accountTrade` | `user` | `data:[{E, T, t, s, i, c, S, p, q, f, m, d}]` **no user** | Account.tsx |
| `accountOrderUpdate` | `user` | `data:[{E, s, c, i, S, o, f, p, q, X, z, v, M, ps, R, T, x, r}]` **no user** | Account.tsx |
| `accountUpdate` | `user` | balances (not sampled) | Account.tsx |

WS limits per IP (docs): 10 connections, 30 new/min, **1000 subscriptions, 10 unique users**, 2000 messages/min, 100 inflight.

### 4.5 Other hosts the code touches

| Host | Endpoints | Auth / CORS | Notes |
|---|---|---|---|
| `mainnet-data.sodex.dev` | `/api/v1/leaderboard?window_type(24H/7D/30D/ALL_TIME)&sort_by(pnl/volume)&sort_order&page&page_size(10/20/50; default 20; **`pageSize` ignored**)` → `{window_type, page, page_size, total, snapshot_ts, items[{wallet_address, account_id, pnl_usd, volume_usd, rank}]}`; `/leaderboard/rank?window_type&sort_by&wallet_address` → `{found, snapshot_ts, item}`; `/perps/pnl/overview`, `/perps/pnl/daily_stats`; `/wallet/portfolio/chart?account_id&window(24H/7D/30D/90D/1Y)&market_type`; `/dashboard/{volume,open-interest,tvl,users}?start_date&end_date` → `{data:{data:[{day_date, timestamp, markets{}}], availableMarkets}}`; `/spot/pnl/overview` → 404 | none; CORS reflects origin; Cloudflare | `total` 134,605; snapshot ~hourly (10:00Z snapshot served at ~10:17Z); rate limit **unknown** |
| `alpha-biz.sodex.dev` | `/biz/v1/maintenance/status`, `/biz/announcements(/detail/{id})`, `/biz/config/symbol`, `POST /biz/mirror/create_deposit_addresses` (**creates**; not called here), `POST /biz/mirror/account_flow`, `POST /biz/mirror/v2/combined_transfers`, `/biz/soso_airdrop/claim_status`, `/biz/sopoints/*` (bearer), `/biz/referral/public/referralCode` | CORS reflects origin | Envelope `{code, msg}` |
| `sodex.dev/{mainnet|testnet}/chain/` | `user/{id}/address`, `address/{addr}/accounts`, `tradable-tokens` | none | id↔address resolver |
| `sodex.com/auth/v2/{nonce,verify}` | SoPoints sign-in | Origin allowlist | proxied with a spoofed Origin; drop |
| `rpc.valuechain.xyz` | `eth_call`, `eth_getBalance`, `eth_blockNumber` | none | chain 286623 |
| `main-scan.valuechain.xyz/api/v2` | `/tokens?type=ERC-20`, `/addresses/{a}`, `/counters`, `/token-balances` | none | Blockscout |
| `www.communityscan-sodex.com` | `/api/public/wallet/{addr}` | none | third party, scan.ts only |
| `api-perps.katana.network` | `/v1/{ping,time,markets,tickers,orderbook,trades,candles}` | none, no CORS | Katana adapter, unregistered |

---

## 5. Tests

- **Count:** 198 tests in 11 files, **all passing** (verified 2026-09-25, 7.8 s). NOTES.md's "98" and README's "189" are stale.

  | File | Tests |
  |---|---|
  | katana | 47 |
  | vectors | 34 |
  | logic | 27 |
  | chain | 20 |
  | multiaccount | 17 |
  | elevation | 16 |
  | regressions | 15 |
  | mirror | 8 |
  | deviceKey | 7 |
  | depositRegistry | 4 |
  | expiry | 3 |

- **How to run:** from the repo root, `npm test`, which runs `tsx --test test/*.test.ts` in `server/`. Or `cd server && npx tsx --test test/*.test.ts`. Typecheck with `npm run typecheck`.
- **Offline and safe:** they use `https://test.invalid`, a monkey-patched `globalThis.fetch`, and `os.tmpdir()` scratch dirs. No live network, no writes to the repo (`git status` clean after the run).
- **Test coverage relevant to Valuescan:**
  - vectors (signing parity with Go);
  - regressions from the adversarial review (funds zero-check, maxNotional with a minNotional "0" sentinel, stopPrice tick snapping, TP/SL with funds-denominated entries);
  - `isTransientFailure`, `weightFor`;
  - multi-account nonce ordering under budget contention (`multiaccount.test.ts`);
  - elevation intent binding;
  - origin parsing.
- **Not tested:** `history.ts` (no pager tests), `hub.ts` routing, `stats.ts`, `scan.ts`, and all of `web/` (no Playwright; NOTES.md:427). The pager should gain tests before it is ported.

---

## 6. Data volume and cost numbers (for questions 1–2)

| Quantity | Value | Confidence |
|---|---|---|
| Perps trade firehose | **10.9 prints/s**, 67 distinct accounts in 30 s, ~199 B/print wire JSON, 2.1 KB/s | verified (30 s sample, Fri 10:25 UTC) |
| Spot trade firehose | 1.7 prints/s, 4 accounts/30 s, 0.5 KB/s | verified (same) |
| Extrapolated firehose | ~0.9–1.1M prints/day, ~200 MB/day raw JSON; volume swings ~6× day to day | inferred |
| Venue perps volume, 17–23 Sep 2026 | $94M – $601M/day; spot $1.5–2.3M/day; 123–131 markets | verified (`dashboard/volume`) |
| Ranked accounts (leaderboard `total`) | 134,605 | verified |
| Full id↔wallet crawl | 2,693 requests at `page_size=50` | inferred (arithmetic) |
| Heavy account history | 305k spot + 40k perps fills / ~7 months; peak 4,266 perps fills/day | verified (local cache) |
| Opentrade storage cost | 231 MB / 349k rows ≈ 660 B/row (SQLite + raw JSON + index) | verified |
| REST backfill ceiling per IP | 1000-fill page = 70 weight ⇒ ~17 pages/min ≈ 17k fills/min ≈ 24M fills/day at the documented 1200/min (5× if the 6000 header is the real cap) | inferred |
| Polling open positions | `state` = 5 weight ⇒ ≤ 240 accounts/min/IP at 1200 | documented weights |
| Venue push latency `E−T` | perps p50 41 / p90 66 / p99 78 ms; spot p50 17 / p90 25 / p99 32 ms | verified (30 s) |
| Receipt latency on this PC | recv−T ≈ 560–620 ms, a flat distribution ⇒ dominated by local clock offset; HTTP TTFB 340–540 ms vs TCP connect 45–250 ms to the Cloudflare FRA edge ⇒ the origin is far from Frankfurt | inferred; measure from an NTP-synced box near the origin |

---

## 7. Defects and stale claims to fix during porting

| # | Where | Problem | Evidence |
|---|---|---|---|
| 1 | `scan.ts:94` | `Number(p.positionSide) === 2`, but REST returns `"BOTH"` ⇒ every position labelled SHORT; derive the side from the sign of `size`/`sz` | verified live |
| 2 | `scan.ts:101-103` | reads `unrealizedProfit`, `liquidationPrice`, `isolatedMargin`, which do not exist on `/positions` ⇒ always null; use `state.P.ur`, `state.P.lp` | verified live |
| 3 | `scan.ts:340` | reads `t.lastPrice ?? t.close`; tickers use `lastPx` ⇒ spot prices never set | verified live |
| 4 | `scan.ts:209` | `pageSize` is ignored upstream (default 20); use `page_size` | verified live |
| 5 | `hub.ts:150-155`, `ws.ts:116-125` | account pushes have no `user`, so multi-user routing leaks and misattributes | verified live |
| 6 | `rest.ts:169-189` | weight table under-counts (default 5 vs 20, klines, orderbook>500, batch, transfer) | documented |
| 7 | `rest.ts:5-8`, `rest.ts:490-501` | "nonces must strictly increase": the docs now say a 100-nonce window per signer | documented |
| 8 | `web/src/signing.ts:88` | expiry in ms compared with seconds ⇒ never expires locally | code |
| 9 | `web/src/signing.ts:174,216` | no `code≠0` check ⇒ an HTTP-200 error envelope is treated as data | code + verified envelope behaviour |
| 10 | `index.ts:117-135` | `venueRoutes` never registered ⇒ the venue abstraction and Katana are dead at runtime | code |
| 11 | NOTES.md:48 / README:282 | test count 98 / 189 → actually 198 | verified run |
| 12 | NOTES.md:234-236, DEPLOYMENT.md:135-137 | "gateway does not serve permissive CORS for signed writes" is false; the preflight allows `*` and `X-Api-*` | verified live |
| 13 | wallet.ts / userSigned.ts | key registration uses the older `/{engine}/accounts/api-keys` + `UserSignedAddPermissionedAPIKeyAction`; the docs now document `/api/v1/user/{addr}/api-keys` + `AddAPIKey(…,nonce)` (domain chainId = network id, no message chainID) and `AddAPIKeyWithBuilder` | documented; the old path worked in Aug 2026 |
| 14 | TODO.md:37-40 | "position PnL/liq field names unconfirmed": now resolved (item 2 / §4.2) | verified live |

---

## 8. Facts table

| # | Claim | Confidence | Source |
|---|---|---|---|
| 1 | Signing output matches the Go SDK on 19 vectors / 34 assertions; tests pass | verified | `server/test/vectors.test.ts`, local run 2026-09-25 |
| 2 | 198/198 server tests pass offline in ~7.8 s | verified | `npx tsx --test test/*.test.ts` |
| 3 | WS `trade` prints carry `bi`/`si` account ids (516/516 sampled) | verified | live WS probe; `web/src/components/TapeFilter.tsx:8-25` |
| 4 | REST `/markets/{s}/trades` has no `bi`/`si` | verified | live GET; `api.ts:209-216` |
| 5 | One socket accepted `trade` for 98 symbols + 8 other subs, 0 failures | verified | live WS probe |
| 6 | `accountTrade`/`accountOrderUpdate` pushes lack a `user` field | verified | live WS probe |
| 7 | WS limits: 10 conns, 1000 subs, 10 unique users, 2000 msgs/min per IP | documented | `developers_trading_api-rate-limits.md` |
| 8 | REST: 1200 weight/min/IP (docs); gateway sends `x-ratelimit-limit: 6000` | documented + verified header | docs; live headers |
| 9 | History endpoints: weight 20 + items/20; page max 1000; `endTime` inclusive | documented + verified (author) | docs; `history.ts:17-22` |
| 10 | ~8% of history pages return HTTP 200 with `code:-1` | verified (author, Aug 2026) | `rest.ts:96-104`, `rest.ts:576-593` |
| 11 | `tradeID` is not unique (989 distinct / 1000 fills) | verified (author) | `history.ts:176-196` |
| 12 | `positions/history` exists: bare, `limit=1000`, `realizedPnL` per closed position | verified | live GET |
| 13 | `/positions` lacks uPnL/liq; `state.P` has `ur`, `lp`, signed `sz` | verified | live GET |
| 14 | Leaderboard: 134,605 accounts; `page_size ∈ {10,20,50}`; `pageSize` ignored; ~hourly snapshot | verified | live GET |
| 15 | id→address works via leaderboard, `sodex.dev/…/user/{id}/address`, on-chain `0x792713b8` | verified | live GET + `eth_call` |
| 16 | Gateway preflight for signed POST: ACAO `*`, allows `X-Api-Key/Sign/Nonce/Chain` | verified | live `OPTIONS` |
| 17 | `web/src/signing.ts` (browser signer) is not imported anywhere | verified | grep |
| 18 | `venueRoutes` is not registered | verified | `server/src/index.ts:117-135` |
| 19 | Katana = Katana Perps (IDEX team, acquired Mar 2026) | documented | GlobeNewswire, Katana docs |
| 20 | Nonces: 100 highest kept per signer; window (T−2d, T+1d) | documented | `developers_trading_api-keys-and-nonces.md:140-155` |
| 21 | Max 5 API keys per master account; max 10 builder approvals per user | documented | api-keys doc:11; builder-codes.md:13 |
| 22 | Builder: `{id, fee}` in tenths of bp, last field; perps cap 200, spot 2000; builder needs 100 vUSDC in both engines | documented | builder-codes.md:7-39,109-124 |
| 23 | Address action quota = cumulative USDC volume + 10,000 | verified | live `/user/{addr}/ratelimit` |
| 24 | Order limits: 600/min and 20/s per account with an API key | documented | rate-limits doc |
| 25 | Firehose ~10.9 perps + 1.7 spot prints/s; `E−T` p50 41 ms perps | verified (30 s sample) | live WS probe |
| 26 | Opentrade SQLite ≈ 660 B/row; one bot had 345k fills in ~7 months | verified | local cache copy |
| 27 | `scan.ts` position side/PnL/price field bugs | verified | live shapes vs `scan.ts:94-103,340` |
| 28 | `expiresAt` for API keys is milliseconds | verified (author) | `wallet.ts:55-77`; docs example `expiresAt = nonce + 24h` in ms |

---

## 9. Open questions (cannot be settled read-only)

1. **What permissions does a key registered with `AddAPIKeyWithBuilder` get?** The docs say `builder` and `permissions` are mutually exclusive. If such a key defaults to full rights (including WITHDRAW), the one-signature onboarding would hand the executor a fund-moving key. *How to verify:* on testnet, register a key via `AddAPIKeyWithBuilder` and read `permissions` back from `/api/v1/user/{addr}/api-keys`. Until then, use `AddPermissionedAPIKey(mask 3)` plus a separate `ApproveBuilderFeeAction`, which costs two wallet prompts.
2. **Does the exchange actually refuse a withdrawal signed by a mask-3 key?** Never observed (DEPLOYMENT.md:43-49). *Verify:* on testnet with a funded account, try `transferAsset` with a mask-3 key and expect a rejection.
3. **What does `x-ratelimit-limit: 6000` count** (requests or weight), and does the documented 1200 weight/min also apply at origin? *Verify:* from an otherwise idle IP, issue known-weight calls and diff `x-ratelimit-remaining`.
4. **The data host (`mainnet-data`) has no documented rate limit.** It is needed for the 2,693-page leaderboard crawl. *Verify:* crawl slowly and watch for 429 or Cloudflare challenges; or ask SoDEX.
5. **Does the `trade` firehose include liquidation, ADL or takeover fills,** and does it ever drop prints (sequence gaps in `t`)? *Verify:* run the firehose alongside REST `/accounts/{a}/trades` for a set of accounts over a day and reconcile.
6. **WS `Origin` policy** for browser connections from a Valuescan domain. Not testable from Node (it sends no Origin). *Verify:* one browser tab on a staging origin.
7. **Where SoDEX's origin servers are.** The edge→origin leg is ≈ 280+ ms from FRA. This matters for where to place the executor. *Verify:* compare TTFB from a few regions (without launching test instances; see the AWS hard rule) or ask SoDEX.
8. **Is the old `/{engine}/accounts/api-keys` + `UserSignedAddPermissionedAPIKeyAction` path still accepted,** or is it deprecated in favour of `/user/{addr}/api-keys`? *Verify:* a testnet signature-layer probe, as NOTES.md did (a rejection at the auth layer is enough).
9. **Pagination and time filters of `positions/history`** (`startTime`/`endTime` semantics, maximum depth). *Verify:* a read-only walk on a busy account.
10. **The exact Go struct field order for builder-enabled orders and the new key actions.** *Verify:* read the current `sodex-go-sdk-public` / Python SDK source and regenerate vectors with `genvectors.go`.

---

## 10. Recommendations for Valuescan

1. **Create `packages/sodex-core` (isomorphic, ESM, no Node APIs)** by lifting these unchanged:
   - `signing/eip712.ts`, `signing/actions.ts`, `signing/userSigned.ts`;
   - `decimal.ts`;
   - `symbols.ts:normaliseOrder/mulDecimal`;
   - `rest.ts:unwrapList`/`isTransientFailure` and the envelope-assertion logic from `send()`;
   - `ws.ts:CHANNEL_PARAM_STYLE`/`normaliseSubParams`/`subKey`;
   - `venues/types.ts`;
   - `web/src/risk.ts`.

   Bring along `vectors.json`, `vectors.test.ts`, `regressions.test.ts` and `logic.test.ts`. Then add builder fields plus `AddAPIKey`, `AddAPIKeyWithBuilder` and `ApproveBuilderFeeAction`, with **new Go-generated vectors** as the gate.
2. **Build the indexer on the `trade` firehose, not on per-account polling:**
   - one `Upstream` per engine, subscribed to all symbols (≈141 subs);
   - each print is written to the fills store keyed `(engine, t)`, with `bi`/`si` → taker/maker from `S`;
   - new ids are resolved via a leaderboard crawl (bulk), then `sodex.dev`, then on-chain;
   - REST (`history.ts` pager) is used only for **backfill** of newly tracked accounts and for **gap repair** after reconnects;
   - `state` polling (weight 5) is used only for followed and tracked leaders, to reconcile positions, uPnL and liq;
   - `positions/history` gives per-trade PnL and win-rate.
3. **Port `history.ts` logic, not its storage.** Keep the inclusive `endTime`, whole-row hash dedupe (switch to `(engine, account, tradeID, orderID, time, price, qty)` or keep a hash), per-page checkpoints and the "failed page ≠ end" rule. Replace SQLite with columnar storage and the Maps with a durable queue. Write pager unit tests first; none exist.
4. **Make the rate budget a shared, per-egress-IP token service** (e.g. Redis), with the corrected weight table. Treat the documented 1200/min as the ceiling until question 3 is answered, and back off on `x-ratelimit-remaining`.
5. **Public read API (b):** port `external.ts` (leaderboard/rank/maintenance/announcements) and the provenance-labelled response design from `stats.ts`. Serve Valuescan's own rankings from indexed data, and keep SoDEX's `pnl/overview`, `daily_stats` and `wallet/portfolio/chart` as a labelled "venue" view. Do **not** port `scan.ts` (CommunityScan dependency, field bugs) or `pointsAuth.ts` (Origin spoofing).
6. **Copy executor (c):**
   - reuse `SodexClient`'s signed path with one mask-3 key per follower (own nonce tracker);
   - reuse `normaliseOrder` before every signature, and `trade.ts`'s perps order assembly (reduce-only exits, spot-trigger refusal);
   - reuse `wallet.ts`'s prepare/complete delegation flow, with key generation moved into KMS or an enclave.
   - Never port `elevation.ts` or `money.ts` into the executor.
   - Guard every follower against the per-address action quota (`/user/{addr}/ratelimit`) and the 600/min / 20/s order caps.
   - Filter out market-maker-like leaders (thousands of fills/day), because followers cannot keep up with their action budget.
7. **Browser (d):**
   - wire `web/src/signing.ts` after fixing the expiry units and envelope checks;
   - register keys via `POST /api/v1/user/{addr}/api-keys`;
   - subscribe to own-account WS channels directly at SoDEX (the 10-users/IP limit then applies per user, not to our servers);
   - move deposit, elevation and transfer flows in-tab;
   - keep `accountFeeds.ts`, `performance.ts`, `scanChain.ts` and `risk.ts` as they are.
8. **Hyperliquid (later):** extend `venues/types.ts` with account-level methods (fills, positions, funding, equity). Reuse Katana's `TokenBucket` and `katanaBackoffMs` for HL's REST weight budget, and drop the Katana adapter itself.
9. **Fix and document** items 1–14 in §7 when code moves over. Most importantly, never route account-channel pushes by `data.user`.
10. **Before any mainnet use,** close open questions 1, 2 and 8 on **testnet**, and only with the owner's explicit go-ahead. None of them was attempted here.
