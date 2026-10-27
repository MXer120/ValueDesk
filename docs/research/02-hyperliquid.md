# 02 — Hyperliquid: data access and copy-execution primitives

*Research for ValueDesk, dated 2026-09-25. This is research, not a design. Nothing was deployed, signed, approved or registered.*

**What I did.** All checks were public and unauthenticated:
- `POST https://api.hyperliquid.xyz/info` queries: about 60 requests in total, spaced ≥250 ms apart.
- Public `wss://api.hyperliquid.xyz/ws` subscriptions, in 8 sessions of 10–180 s each.
- One download each of the public leaderboard and vault JSON.
- Five small `builder_fills` CSVs.
- Six `eth_call` / `eth_getCode` reads against the HyperEVM public RPC.
- Anonymous S3 listing attempts. Both were refused, and nothing was downloaded from a requester-pays bucket.

**Where I ran it from.** A German residential IP, which reached HL through the CloudFront edge FRA56/FRA60. The local clock was measured about 0.4–0.5 s off NTP, which matters for the absolute latency figures.

Confidence labels:
- **verified** means I observed it live today or in code.
- **documented** means it is in official HL docs or the node repo.
- **inferred** means reasoning from verified or documented facts.
- **assumption** means a working hypothesis that still has to be checked.

The HL docs cited below were fetched as raw markdown by appending `.md` to the gitbook URL, for example `https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits.md`.

---

## TL;DR

1. **Every trade on HL is publicly attributable to both counterparties, in real time, for free.**
   - The WS `trades` channel carries `users: [buyer, seller]` on every print. I verified 16,205 of 16,205 trades.
   - One connection with about 340 subscriptions (all perps, HIP-3 `xyz` and liquid spot) receives the complete market fill stream. The limit is 1,000 subscriptions.
   - That stream arrives **at the same moment as the per-user `userFills` push**. The measured difference had a median of 0 ms (n=14).
   - This is the cheapest way both to discover all traders and to detect leader trades.
2. **Per-user WS streams are capped at a small number of tracked users.**
   - The docs say "10 unique users". The live error today was **"Cannot track more than 15 total users."**
   - Across 4 parallel connections, two accepted 15 users each and two were refused. The cap appears to apply per IP per backend server, so it cannot be relied on beyond 10–15 users per IP.
   - Use per-user channels (`orderUpdates`, `userFills`) only for the top leaders. Use the `trades` firehose for everyone else.
3. **REST budget is 1,200 weight/min/IP.**
   - Weights:
     - `clearinghouseState` / `spotClearinghouseState` / `l2Book` / `orderStatus` cost 2.
     - Most user queries cost 20.
     - `userRole` costs 60.
     - `userFills`, `userFillsByTime` and `historicalOrders` add weight per 20 items returned.
   - Fill history is limited to the **10,000 most recent fills per address**, returned in pages of 2,000. That rules out full history for active traders via the API.
   - Full history must come from S3: `hl-mainnet-node-data/node_fills_by_block`, requester-pays, `ap-northeast-1`, about 0.8–1.0 GiB/day lz4. Alternatives are Hydromancer's Reservoir Parquet (requester-pays, `ap-northeast-1`) or our own node.
4. **Browser-direct reads work.**
   - `/info` returns `access-control-allow-origin: *` and preflight allows any method or header.
   - WS upgrades from a foreign `Origin` return `101`.
   - The leaderboard, vault and builder_fills files are CORS `*` too.
   - Trader detail pages can query HL from the user's own browser, on the user's IP budget, at zero backend cost.
5. **Leaderboard JSON** is at `https://stats-data.hyperliquid.xyz/Mainnet/leaderboard`.
   - It is 39.1 MB, served uncompressed, and regenerated **hourly** (Last-Modified 09:51:00, then 10:51:07 UTC).
   - It has 46,887 rows: address, account value, and day/week/month/allTime pnl, roi and volume.
   - Rows appear to be accounts with **account value ≥ $100k OR all-time volume ≥ $10M** (inferred from the data).
   - Rows **aggregate sub-accounts into the master**, so they are not the unit you copy.
6. **Market size today** (live, `metaAndAssetCtxs`):
   - Validator perps: **$7.17B/24h**, open interest $13.3B.
   - HIP-3 dexes: **$2.45B/24h**, of which `xyz` alone is $2.39B. That is about 25% of all volume.
   - Spot: $0.19B.
   - Total: **≈ $9.8B/day**.
   - Trade count sampled from the firehose: **≈ 6–15M trades/day**, that is 12–31M fills/day. There were about 2,200 distinct addresses per 3 minutes.
   - HL's own stats feed (stale since 2026-04-03) showed a 30-day average of **51k daily active users** and 1.2M cumulative users.
7. **Copy execution without custody works via agent (API) wallets.**
   - The master signs `approveAgent`. Limits are 1 unnamed plus 3 named agents per master, and +2 named per sub-account.
   - Setting `agentName` to `"<name> valid_until <ms>"` sets an expiry of **at most 180 days**. `extraAgents` exposes `validUntil`; I verified this.
   - Agents can trade but **cannot withdraw**. `agentSendAsset` only moves funds between the user's own dexes.
   - Nonces keep the **100 highest per signer**, and must fall within **(T−2 days, T+1 day)**.
   - **Pitfall:** approving a new *unnamed* agent de-registers the user's existing unnamed agent, which is usually the HL web UI's key. ValueDesk must use a **named** agent.
8. **Builder codes (monetization).**
   - The main wallet (not an agent) signs `approveBuilderFee`. Each order then carries `builder: {b, f}`, with `f` in tenths of a basis point.
   - Caps are **0.1% perps (f≤100) and 1% spot (f≤1000)**. SoDEX allows 0.2% and 2%.
   - The builder needs **≥100 USDC perps account value** and **standard abstraction mode**.
   - Each user can have at most **10 active approvals**.
   - Per-builder fills are published free and daily at `stats-data.hyperliquid.xyz/Mainnet/builder_fills/{addr}/{YYYYMMDD}.csv.lz4`.
   - Live examples for 2026-09-24: one builder earned **$24.5k/day at 5.0 bps on $49M**. Another earned **$28.8k/day at 9.8 bps on $29M**.
9. **HyperEVM makes a trustless copy vault technically possible.** I verified this live on chain 999:
   - The read precompile `0x…0800` returns **any** address's perp position.
   - `0x…080f` returns its account value.
   - `0x…0807` returns oracle prices.
   - `CoreWriter` at `0x3333…3333` accepts limit orders (IOC/GTC/ALO), cancels, transfers, **`Add API wallet`** (action 9) and **`Approve builder fee`** (action 12).
   - **Catch 1:** order actions sent from CoreWriter are **deliberately delayed "a few seconds"** and are not atomic. Failures do not revert.
   - **Catch 2:** the CoreWriter order encoding has **no builder field**.
   - A fully on-chain mirror therefore lags by seconds and must monetize through a contract fee. A hybrid is possible: the contract holds funds and registers an off-chain agent via action 9, so orders run at API latency.
   - I found no existing trustless HyperEVM copy-trading protocol.
10. **Latency.**
    - Everything lives in **Tokyo**: the Foundation node is in `apne1-az1` and 22 of 25 community seed peers are in Japan.
    - The docs cite about **380 ms end-to-end** for a cancel or ALO order.
    - IOC orders can buy about **45 ms per bp** of priority fee, over the range 0–8 bps.
    - From Germany, a small `/info` round trip took 240–290 ms.
    - The copy engine must run in Tokyo.
11. **The fan-out constraint is per IP, not per follower.**
    - Every follower order is its own signed action, since a batch is single-account. Each costs 1 IP weight, against 1,200/min/IP on REST and 2,000 msgs/min plus 100 in-flight posts on WS.
    - One IP therefore sustains about 20–33 follower orders/s.
    - Per-follower address budgets are not a problem: 10k buffer + 1 per USDC traded, or buy capacity via `reserveRequestWeight` at $0.0005 per request, payable for another user.
12. **Existing tools.**
    - Data players run their own Tokyo nodes: HypurrScan, ASXN, Nansen×HypurrCollective and Hyperdash all appear as root/sentry peers.
    - Copy traders use agent keys plus builder or other fees: Copin 0.05% on open size, Hyperbot 0.1%, Katoshi 0.01% perps.
    - Nobody I found does trustless on-chain copy trading on HL.

---

## 1. Public per-address data (Info endpoint and WebSocket)

### 1.1 Info endpoint: queries and their limits

All requests are `POST https://api.hyperliquid.xyz/info` with body `{"type": ..., "user": "0x..."}`. None needs a signature, and any address can be queried.

In the table, the **reference account** is `0x85ecf584…72052`, the #1 leaderboard row by volume. Its sub-account `0xcf3f419d…f95f` is referred to as "the sub-account".

| `type` | Returns (verified field names) | Limits (documented) | IP weight (documented) | Live observation (verified) |
|---|---|---|---|---|
| `clearinghouseState` (+ optional `dex`) | `marginSummary{accountValue,totalNtlPos,totalRawUsd,totalMarginUsed}`, `crossMarginSummary`, `crossMaintenanceMarginUsed`, `withdrawable`, `assetPositions[{type:"oneWay",position{coin,szi,leverage{type,value},entryPx,…}}]`, `time` | per dex; HIP-3 dexes need `dex:"xyz"` etc. | **2** | 349 B, ~390 ms from DE |
| `spotClearinghouseState` | `balances[{coin,token,total,hold,entryNtl}]` | – | **2** | – |
| `openOrders` / `frontendOpenOrders` | orders. The frontend variant adds `orderType`, `triggerPx`, `isPositionTpsl`, `children`, `tif` | – | 20 | – |
| `userFills` (`aggregateByTime` opt.) | `coin,px,sz,side,time,startPosition,dir,closedPnl,hash,oid,crossed,fee,tid,cloid,feeToken,twapId` (+`builderFee`, `liquidation` when present) | **at most 2,000 most recent**, newest first | 20 + per 20 items | 2,000 rows = 738 KB, 1.4 s |
| `userFillsByTime` (`startTime`, `endTime`, `aggregateByTime`) | same as `userFills` | **2,000 per response; only the 10,000 most recent fills are reachable**; ascending order; paginate with last `time` | 20 + per 20 items | `startTime:0` on the reference account returned fills starting 2026-03-31, i.e. the start of its 10k window |
| `historicalOrders` | `{order, status, statusTimestamp}` | 2,000 most recent | 20 + per 20 items | 756 KB |
| `userFunding` / `userNonFundingLedgerUpdates` | funding payments / deposits, withdrawals, transfers, vault ops (`delta.type`) | time range; the generic rule is 500 elements per response | 20 (+items for `userFunding`) | ledger: 1,114 rows / 30 d on the reference account |
| `portfolio` | 8 windows (`day, week, month, allTime, perpDay, perpWeek, perpMonth, perpAllTime`), each `{accountValueHistory[[ms,val]], pnlHistory[[ms,val]], vlm}` | **per account; does NOT include sub-accounts** | 20 | 42–111 points per window: good for sparklines, too coarse for serious analytics |
| `subAccounts` | `[{name, subAccountUser, master, clearinghouseState, spotState}]` | ≤50 sub-accounts | 20 | 50 sub-accounts = 109 KB |
| `userRole` | `user` / `agent{user}` / `vault` / `subAccount{master}` / `missing` | – | **60** | the sub-account → `{"role":"subAccount","data":{"master":"0x85ec…"}}` |
| `extraAgents` | `[{name, address, validUntil}]` | – | 20 | **88 named agents** on the reference account, e.g. `trade42`, with validUntil up to +180 d |
| `userRateLimit` | `cumVlm, nRequestsUsed, nRequestsCap, nRequestsSurplus` | – | 20 | `nRequestsCap` = `cumVlm` + 10,000 exactly, which confirms the address rule |
| `userFees` | `dailyUserVlm, feeSchedule, userCrossRate, userAddRate, …` | – | 20 | – |
| `referral` | `referredBy, cumVlm, unclaimedRewards, claimedRewards, builderRewards, referrerState, rewardHistory` | – | 20 | – |
| `maxBuilderFee` (`user`, `builder`) / `approvedBuilders` (`user`) | integer, tenths of a bp / address list | – | 20 | used to discover real builder addresses (§3.2) |
| `vaultDetails` (`vaultAddress`, `user` opt.) | `name, leader, apr, leaderFraction, leaderCommission, followers[{user,vaultEquity,pnl,allTimePnl,daysFollowing,vaultEntryTime,lockupUntil}], maxWithdrawable, relationship, allowDeposits, alwaysCloseOnWithdraw, portfolio` | – | 20 | top user vault: `followers` array had exactly **100** entries, so the list is probably truncated at 100 |
| `userVaultEquities` | vault deposits of a user | – | 20 | – |
| `recentTrades` (`coin`) | recent trades **including `users`** | – | 20 + per 20 items | used to sample traders |
| `metaAndAssetCtxs` (+`dex`) / `spotMetaAndAssetCtxs` / `perpDexs` | universe + `funding, openInterest, prevDayPx, dayNtlVlm, premium, oraclePx, markPx, midPx, impactPxs, dayBaseVlm` | – | 20 | 234 perps (178 live), 11 perp dexes, 330 spot pairs |

Sources: `info-endpoint.md` (limits at lines 9, 138, 223, 559), `rate-limits-and-user-limits.md` and live probes.

**Weight arithmetic.** The docs do not state how much weight each block of 20 items adds; 1 per 20 is an **assumption**. On that basis:
- A full 2,000-row `userFills` page costs about **120 weight**.
- A 10k-fill backfill of one address costs about 600 weight, which is half of one IP's per-minute budget.
- Backfilling all 46.9k leaderboard accounts would take about 3.3 IP-days if each has ≤2,000 fills, and about 16 IP-days if each has 10k fills.

### 1.2 Rate limits (documented; source `rate-limits-and-user-limits.md`)

**Per IP:**
- REST: **1,200 weight/min** in aggregate.
- Exchange actions cost `1 + floor(batch_length/40)`.
- Explorer requests cost 40, and `blockList` adds 1 per block.
- HyperEVM public RPC `rpc.hyperliquid.xyz/evm`: 100 requests/min.

**Per address** ("sub-accounts treated as separate users"). These apply to actions only; info requests are unaffected.
- Budget: 1 request per 1 USDC traded cumulatively, plus a **10,000 initial buffer**.
- When limited: 1 request per 10 s.
- Cancel cap: `min(limit+100000, 2*limit)`.
- Open orders: 1,000 + 1 per $5M volume, up to **5,000**. At ≥1,000 open orders, reduce-only and trigger orders are rejected.
- A batch of *n* orders counts as 1 request against the IP limit and *n* against the address limit.
- Under congestion, an address is limited to **2× its previous-day maker share** of block space.
- `expiresAfter`-stale actions cost 5× (`exchange-endpoint.md` line 17).
- **Buying capacity:** `reserveRequestWeight` costs **0.0005 USDC per request**, charged to the perps balance. An optional `destination` lets one pay for **another user**, so ValueDesk could top up followers.

### 1.3 WebSocket

**Channels usable for an arbitrary address** (verified today on third-party addresses):

| Channel | Behaviour observed |
|---|---|
| `userFills` | `isSnapshot:true` first, then live fills |
| `orderUpdates` | Every placement, cancel and fill, with `status` and `statusTimestamp`. This shows a leader's **resting limit orders before they fill**. 946 messages in 120 s for one market-making sub-account. |
| `userEvents` | Delivered on channel `"user"`: fills, funding, liquidations |
| `userFundings`, `userNonFundingLedgerUpdates` | Snapshot, then live |
| `clearinghouseState`, `openOrders` | Periodic pushes: 24 in 120 s, i.e. **~5 s cadence** |
| `activeAssetData` (`user`, `coin`) | Leverage, `maxTradeSzs`, `availableToTrade` |
| `webData3` | Aggregate user state incl. `agentAddress`, `agentValidUntil`, `perpDexStates` |

- **`webData2` is rejected** with `Error parsing JSON into valid websocket request`. It was replaced by `webData3`.
- Also documented: `allDexsClearinghouseState`, `spotState`, `twapStates`, `notification`, `fastAssetCtxs`.

**Market channels:**
- `trades` → `WsTrade {coin, side, px, sz, hash, time, tid, users:[buyer, seller]}` (documented and verified).
- Also `l2Book`, `bbo`, `candle`, `allMids`, `activeAssetCtx`, `allDexsAssetCtxs`.
- The first `trades` message per coin is a **snapshot of recent trades**. Skip it when measuring or ingesting.

**Documented limits (per IP):**
- 10 connections.
- 30 new connections/min.
- 1,000 subscriptions.
- **10 unique users across user-specific subscriptions.**
- 2,000 messages sent per minute.
- 100 in-flight `post` messages.
- The server closes a connection after 60 s idle; send `{"method":"ping"}`.

**Observed today:**
- One connection with 20 `userFills` subscriptions got 15 acks and 5 errors: `"Cannot track more than 15 total users."`
- Two connections × 10 users both succeeded, 20 in total.
- Four connections × 15 users: two were accepted in full (15 + 15), one got 14, and one was fully refused.

The interpretation is **inferred**: the cap is about 15 users, enforced per IP **per API backend**, and CloudFront load-balancing decides which backend a connection lands on. Plan for 10–15 tracked users per egress IP.

**WS post.** Info and signed actions can be sent over WS with `{"method":"post","id":n,"request":{"type":"info"|"action","payload":…}}` (documented, `websocket/post-requests.md`). Explorer requests are not supported over WS.

### 1.4 CORS and browser access (verified)

- `POST /info` with `Origin: https://example.com` returns `access-control-allow-origin: *` and `access-control-expose-headers: *`.
- `OPTIONS` preflight returns `access-control-allow-methods: *` and `access-control-allow-headers: *`.
- WS upgrade with a foreign `Origin` returns `HTTP/1.1 101 Switching Protocols`.
- `stats-data.hyperliquid.xyz` (leaderboard, vaults, builder_fills) returns `Access-Control-Allow-Origin: *`.
- The API is fronted by **CloudFront**: `X-Cache`, `X-Amz-Cf-Pop: FRA60-P5`, and origin `Server: nginx/1.30.3`.

### 1.5 Data-model gotchas (verified)

1. **Sub-accounts.**
   - The #1 leaderboard address holds only **$10.3k** itself (`clearinghouseState`), and its last own fill was 2026-04-21.
   - Its **50 sub-accounts** hold about $36M perp+spot USDC and trade constantly: 342 fills in one hour on the sub-account.
   - The leaderboard row shows $59.8M account value and $1.7B day volume. It is therefore master plus sub-accounts, and probably also vault equity and staking (inferred).
   - `portfolio`, `userFills` and the others are **per account**.
   - Consequence: "trader" in analytics = master plus sub-accounts, but copying has to watch **sub-accounts individually**.
2. **Agents.** Querying an agent address returns empty state. `userRole` maps agent → user, at weight 60, so cache it forever.
3. **Abstraction modes.** For unified-account and portfolio-margin users, "all balances and holds [are] in the spot clearinghouse state. Individual perp dex user states are not meaningful." Documented in `trading/account-abstraction-modes.md`. Account-value analytics must branch on the mode.
4. **One-way positions per asset** (`"type":"oneWay"`). A follower's manual trades and copied trades in the same coin **net against each other**. Isolation requires a sub-account, but sub-accounts need $100k volume (§3.3). Retail followers usually cannot create one.
5. **HIP-3 assets.**
   - Names are `dex:COIN`, e.g. `xyz:XYZ100`.
   - Asset id = `100000 + perp_dex_index*10000 + index_in_meta`. Spot id = `10000 + spotIndex` (documented, `asset-ids.md`).
   - About 25% of today's volume is HIP-3 `xyz`. A copy engine that ignores HIP-3 misses a quarter of leader activity.

---

## 2. Discovering all traders

### 2.1 Leaderboard JSON (verified)

- URL: `GET https://stats-data.hyperliquid.xyz/Mainnet/leaderboard`. It is S3 behind CloudFront.
- **Size:** 39,091,455 bytes. No `Content-Encoding` is offered even with `Accept-Encoding: gzip, br`. Gzip would bring it to 4.6 MB, so cache and re-serve it compressed. Downloaded in 6.7 s from DE.
- **Freshness:** Last-Modified 09:51:00 → 10:51:07 UTC, so **hourly**. CloudFront `Age` was up to 1,133 s.
- **CORS:** `*`.
- **Schema:** `{leaderboardRows:[{ethAddress, accountValue, windowPerformances:[["day",{pnl,roi,vlm}],["week",…],["month",…],["allTime",…]], prize, displayName}]}`.
- **Row counts:**
  - 46,887 rows.
  - 1,468 have a `displayName`.
  - Rows with volume > 0: 8,357 (day), 14,412 (week), 19,136 (month).
  - 15,638 have AV ≥ $100k; 3,015 have AV ≥ $1M.
  - Median AV is $1,777.
- **Inclusion criterion (inferred):** every row with all-time volume < $1M has AV ≥ $100,000.05, and every row with AV < $100 has all-time volume ≥ $10.0M. That implies **AV ≥ $100k OR all-time volume ≥ $10M**.
- **Row sum:** the sum of `day.vlm` is $20.7B, which is two-sided and consistent with about $10B of one-sided volume.
- `https://stats-data.hyperliquid.xyz/Mainnet/vaults` (14.2 MB, CORS `*`) lists 9,475 vaults: 3,103 open, **$428M TVL**. HLP plus its children are about $320M, 85 vaults exceed $100k and 23 exceed $1M.

### 2.2 Trades firehose as a discovery and detection feed (verified)

**Setup.** One WS connection with 178 perp + 109 `xyz` + 54 spot `trades` subscriptions (341 of the 1,000 allowed).

**Sample 1** (180 s at about 10:57 UTC):
- 12,631 trades: 9,898 perp, 2,663 HIP-3, 70 spot.
- **2,170 distinct addresses.**
- $24.7M notional. Extrapolated, that is about 6.1M trades/day and about $11.8B/day.

**Sample 2** (90 s, about 11:08): 16,116 trades, which extrapolates to about 15.5M/day. The flow is bursty.

**Payload.** About 273 bytes of JSON per trade. That is roughly 1.7–4.2 GB/day raw, or **0.33–0.83 GB/day gzipped**, with a gzip ratio of 5.1 and zstd of 5.9. Columnar storage with dictionary-encoded addresses would be smaller still (inferred).

**Latency.**
- For the same `tid`, `userFills` minus `trades` arrival was p10 −1 ms, p50 0 ms, p90 0 ms (n=14).
- `orderUpdates(filled)` minus `userFills` had a median of 0 ms (n=25).
- **Conclusion (verified):** the public trades feed is as fast as the private-looking per-user feeds.

**What the feed lacks:**
- `closedPnl`, `fee`, `startPosition`, `dir`, `oid` and liquidation flags. Those come from `userFills` or node fills.
- Positions must be reconstructed from fills, seeded and periodically reconciled with `clearinghouseState` at weight 2.

### 2.3 S3 archives

| Bucket / path | Access (verified) | Content (documented) | Size / cost |
|---|---|---|---|
| `s3://hyperliquid-archive` | **Requester-pays**, region **us-east-1**. Anonymous list returned `AccessDenied: Anonymous users cannot invoke requests against Requester Pays buckets` | `market_data/[date]/[hour]/l2Book/[coin].lz4` (L2 snapshots), `asset_ctxs/[date].csv.lz4`. Uploaded "approximately once a month", "no guarantee", "No other historical data sets" (no fills, no candles) | Not measured (not listed, to avoid cost) |
| `s3://hl-mainnet-node-data` | **Requester-pays**, region **ap-northeast-1** (Tokyo) | `node_fills_by_block` (fills streamed via `--write-fills --batch-by-block`, API fill format); older `node_fills` and `node_trades` (different format); `explorer_blocks`, `replica_cmds` (L1 txs); `misc_events_by_block` (transfers, staking, funding) | Third party (bond-labs-dev/hyperliquid-data): `node_fills_by_block` since 2025-07-27, `node_fills` 2025-05-25..07-27, `node_trades` "dead". **Fills ≈ 0.8–1.0 GiB/day lz4** (June 2026 sample: 24.61 GiB / 30 d). ~$0.09/GB egress to internet → ~$2.2/month of fills. In-region (Tokyo) S3→compute transfer is normally free; only request fees apply (standard AWS pricing, inferred) |
| `s3://hydromancer-reservoir` (third party) | Requester-pays, ap-northeast-1 (Hydromancer docs) | Parquet, partitioned `date=…`, `by_dex/…`: **fills** (27 columns incl. PnL, builder/deployer fees, priority gas, liquidations/ADL/TWAP), **1-s OHLCV candles**, **daily snapshots of every trader's positions, spot balances and account values**, 20-level L2 at 1-min | Updated daily (books weekly). Total size not published |
| `https://stats-data.hyperliquid.xyz/Mainnet/builder_fills/{builder_lowercase}/{YYYYMMDD}.csv.lz4` | **Public, free**, CloudFront, CORS `*` (verified) | CSV header (verified): `time,user,coin,side,px,sz,crossed,special_trade_type,tif,is_trigger,counterparty,closed_pnl,twap_id,builder_fee` | 45 KB–1.2 MB/day per builder |

**Deliberately not done:** no `aws s3 ls --request-payer requester` and no downloads, per the rules. A `LIST` costs fractions of a cent, but it still needs the owner's go and an AWS identity. Owner-approved commands for exact sizes are listed in §Open questions.

### 2.4 Running a non-validating node (documented: `github.com/hyperliquid-dex/node` README, `optimizing-latency.md`, `l1-data-schemas.md`)

**Specs and footprint:**
- **Non-validator: 16 vCPU, 128 GB RAM, 500 GB SSD, Ubuntu 24.04 only.** Ports 4001–4002 must be open publicly, or peers deprioritize the node.
- **"For lowest latency, run the node in Tokyo, Japan."**
- For latency-optimized reads the docs recommend ≥32 cores, 128 GB and 500 MB/s disk.
- **Disk: "around 100 GB of logs per day"** with default settings, so rotate or archive.
- Setup is low complexity: download `hl-visor` from `binaries.hyperliquid.xyz`, gpg-verify it, then run `~/hl-visor run-non-validator`.
- Mainnet needs ≥1 root peer IP in `~/override_gossip_config.json`. `{"type":"gossipRootIps"}` lists candidates. 22 of the 25 community root IPs are in Japan (ASXN, Nansen×HypurrCollective, Hypurrscan, B-Harvest, and others).

**Output flags:**

| Flag | Output |
|---|---|
| `--write-fills` | `node_fills/hourly/{date}/{hour}`, API fill format; `deployerFee` for HIP-3; TWAP statuses |
| `--write-trades` | `side_info[{user,start_pos,oid,twap_id,cloid}]` for buyer and seller |
| `--write-order-statuses` | Every order status of every user. "Can be a substantial amount of data." |
| `--write-raw-book-diffs` | L4 book diffs |
| `--write-misc-events` | Miscellaneous events |
| `--write-system-and-core-writer-actions` | CoreWriter and HyperCore→HyperEVM actions |
| `--batch-by-block` / `--stream-with-block-info` | Block metadata `{local_time, block_time, block_number, events}` |
| `--disable-output-file-buffering` | Lowest latency |
| `--serve-info` | Local `/info` on `:3001` for state-only queries |
| `--serve-eth-rpc` | HyperEVM RPC |

- `--serve-info` supports `clearinghouseState, spotClearinghouseState, openOrders, frontendOpenOrders, subAccounts, userRole, extraAgents, userRateLimit, userFees, maxBuilderFee, vaultSummaries, userVaultEquities, leadingVaults, webData2, …`. It serves **no historical series and no WS**.
- The local info server has **no rate limit**: ValueDesk could poll `clearinghouseState` for thousands of leaders.
- `fileSnapshot` → `l4Snapshots` dumps the full order book with users.

**Fastest inputs:**
- `split_client_blocks: true` streams uncommitted mempool transactions to `~/hl/data/mempool_txs`, "70–150 ms improvement".
- Read priority: gossip-priority auction, "approximately 25 ms reduction in latency per auction slot", minimum 0.1 HYPE.

**Foundation non-validator (`apne1-az1`):** requires **10,000 HYPE staked plus maker-rebate tier ≥1**, so it is not realistic for us. Paid peers include Alchemy, Allium, ASXN, DoubleZero, Dwellir, Hydromancer, Hyperdash, HyperTracker, QuickNode and others. The Foundation's "benchmark price is less than $1k/month" (documented).

**Cost:**
- Hydromancer estimates "around $1k/month, including server and data-archive costs" (third party).
- A 16 vCPU / 128 GB Tokyo cloud VM at on-demand prices is roughly the same order (assumption; check AWS or bare-metal pricing).
- **Per the owner's hard rule**, any such box must be one persistent, IaC-defined instance. No create/delete churn.

### 2.5 Activity quantification

| Metric | Value | Confidence / source |
|---|---|---|
| 24 h notional, validator perps | **$7.17B** (178 live of 234 listed; BTC $3.16B, ETH $0.92B, HYPE $0.60B, ZEC $0.54B) | verified, `metaAndAssetCtxs` 2026-09-25 ~10:45 UTC |
| 24 h notional, HIP-3 (10 dexes) | **$2.45B** (`xyz` $2.39B; `io` $26M; `mkts` $21M; `para` $5M; others ≈0) | verified, `metaAndAssetCtxs{dex}` |
| 24 h notional, spot | $0.19B (330 pairs) | verified |
| Open interest (validator perps) | $13.27B | verified |
| Trades/day | ≈ 6–15M (2 samples); fills = 2× | verified sample, extrapolated (inferred) |
| Unique addresses in 3 min | 2,170 | verified |
| Daily active users | 51,213 (30-day average), 45,897 (90 d), peak 98,960 | HL stats endpoint `d2v1fiwobg9w6.cloudfront.net/daily_unique_users`. **Series stops at 2026-04-03** even though the file is re-uploaded (Last-Modified today), so it is stale |
| Cumulative users | 1,199,467 at 2026-04-03 | same, `cumulative_new_users` |
| `daily_trades` series | 0.4–2.5 **billion**/day | Same source, but not credible as fill count (compare 6–15M measured); it probably counts orders or book events. Do not use |
| DefiLlama | API now returns "Upgrade to the paid API plan" | verified |

### 2.6 Third-party data vendors (buy instead of build)

| Vendor | Offer | Price |
|---|---|---|
| Hydromancer | WS (books, trades, account updates, liquidations), historical API, free Reservoir S3 | Starter $300/mo (10 book streams), Growth $1,200, Scale $2,500, Enterprise custom (docs.hydromancer.xyz) |
| HyperTracker (CoinMarketMan) | Wallet/cohort analytics API, webhooks; WS only on top tier | Free 100/day; $179/mo (60 req/min) … $1,999/mo (500 req/min, WS) |
| CoinGlass | `/api/hyperliquid/whale-position` (positions > $1M notional), `/whale-alert` | CoinGlass API plans (not checked) |
| Dwellir, QuickNode | gRPC `StreamFills` (every fill, SDK schema), peering | Sales / "<$1k/mo" benchmark for peering |

---

## 3. Copy-execution primitives

### 3.1 API / agent wallets (documented: `nonces-and-api-wallets.md`, `exchange-endpoint.md` §Approve an API wallet)

**Creation and quotas:**
- Created by `approveAgent {hyperliquidChain:"Mainnet", signatureChainId (e.g. "0xa4b1"), agentAddress, agentName?, nonce}`. The master's main wallet signs it (user-signed EIP-712).
- **Quota:** "1 unnamed approved wallet and up to 3 named ones. And additional 2 named agents are allowed per subaccount". Also stated as "starts at 3 … increases by 2 per sub-account" (`trading/sub-accounts.md`). **Verified:** the reference account (50 sub-accounts) has 88 named agents, within 3 + 2×50 = 103.
- **Expiry:** append `valid_until {timestamp}` to the name; **max 180 days**. Verified: `extraAgents[].validUntil` and `webData3.userState.agentValidUntil`.

**Pruning:**
- Agents are pruned on (1) de-registration, when a new unnamed agent is approved or a name is re-approved, (2) expiry, or (3) "the account that registered the agent no longer has funds".
- After pruning, nonce state can be dropped. **Never reuse agent addresses**, or old signed actions can be replayed.

**Signing and scope:**
- An agent signs for the master **and any sub-account or vault** via `vaultAddress`.
- Info queries must use the real account address, not the agent.
- It **cannot withdraw**: withdrawals and transfers are user-signed.
- `agentSendAsset` (agent-signed) moves collateral only between the user's own perp dexes and spot ("Destination must match the source address").
- `userRole` of an agent returns a single `{user}`. Whether one agent key can serve several masters is **unknown** (§Open questions). Nonce sharing makes that a bad idea anyway.

**Nonces:**
- **The 100 highest nonces per signer** are kept. A new nonce must be > the smallest in the set and unused, and within **(T − 2 days, T + 1 day)** of block time.
- The docs recommend one agent per process and per sub-account, batching every 0.1 s, keeping ALO-only batches separate (they are prioritized), and an atomic ms-timestamp counter.

**Safety:**
- `scheduleCancel` is a dead-man switch.
- `expiresAfter` sets an action expiry (5× rate cost if it triggers).

**ValueDesk implication (inferred):**
- One freshly generated **named** agent per follower, e.g. `valuescan valid_until 1805000000000`.
- Rotate before 180 days.
- Never use the unnamed slot, because that would log the user out of app.hyperliquid.xyz.

### 3.2 Builder codes (documented: `trading/builder-codes.md`, `exchange-endpoint.md`)

**Rules:**
- `approveBuilderFee {maxFeeRate:"0.05%", builder, nonce, …}` must be signed by the **main wallet, not an agent**. A HyperEVM contract account can do it via CoreWriter action 12.
- Orders then carry `"builder":{"b":addr,"f":tenthsOfBp}`. The agent can add this.
- **Caps: 0.1% perps (`f ≤ 100`), 1% spot (`f ≤ 1000`).**
- The fee applies to both sides of perps. For spot it applies only to fees taken in quote, so not to the buy side.
- **The builder must have ≥100 USDC perps account value and be in standard abstraction mode** (`account-abstraction-modes.md`: "Builder code addresses must be in standard mode to accrue builder fees").
- **Max 10 active approvals per user.** A user whose 10 slots are full must revoke one first.
- Fees are claimed through the referral reward claim.
- Revenue is visible in `referral.builderRewards` and per-fill in `builder_fills` (public), plus `builderFee` in `userFills`.

**Live benchmarks** (verified: 4 builder addresses discovered through `approvedBuilders` of 40 random recent traders, CSVs for 2026-09-24):

| Builder address | Fills | Users | Notional | Builder fees | Avg rate |
|---|---|---|---|---|---|
| `0xb84168cf…ff80b` (widely attributed to Phantom, which is an assumption) | 28,947 | 3,455 | $49.05M | **$24,527** | 5.00 bps |
| `0xe95a5e31…53aa` | 11,024 | 983 | $29.33M | **$28,802** | 9.82 bps (≈cap) |
| `0x49509948…9395` | 1,066 | 134 | $1.39M | $611 | 4.40 bps |
| `0x9254c66f…f55a` | 7,897 | 58 | $0.13M | $57 | 4.52 bps |

**Referrals (documented, `referrals.md`):**
- Code creation needs $10k volume.
- The referrer earns **10% of referees' fees** on their first $1B of volume.
- Referees get a 4% discount on their first $25M.
- The discount does not apply to sub-accounts or vaults.
- Referral and builder income stack (inferred).

**Fees context** (documented, `trading/fees.md`): perps base taker 0.045%, maker 0.015%, decreasing down to 0.024% / 0% at >$7B 14-day volume. Spot 0.070% / 0.040%.

### 3.3 Sub-accounts (documented, `trading/sub-accounts.md`)

- **10 sub-accounts after $100k volume**, +1 per additional $100M volume, **max 50**.
- They have no private keys: the master or an agent signs with `vaultAddress`.
- They share the master's fee tier. Referral discounts do not apply.
- They have their own address-based rate limits.
- For copy trading, a dedicated sub-account per follower would isolate copied positions from manual ones (one-way netting, §1.5). But **followers under $100k volume cannot create one** (inferred UX problem).

### 3.4 Legacy HyperCore vaults (documented: `hypercore/vaults/*-legacy.md`; verified via `vaultDetails` and the vaults JSON)

**Rules:**
- Leader profit share **10%**.
- Creation: min **100 USDC** deposit, plus a documented **"10k USDC gas fee"**. Historically it was 100 USDC; re-check before relying on it.
- Leader must keep **≥5%** of the vault.
- Lock-up: **1 day** for user vaults, **4 days** for HLP.
- Vaults can trade **validator perps only** (no spot, no HIP-3).
- On withdrawal, orders are cancelled; if margin is still short, **20% of positions are closed** repeatedly. Optionally `alwaysCloseOnWithdraw` (proportional close).
- Close vault: all positions must be closed first.
- The `vaultDetails.followers` list returned exactly 100 entries for a vault that likely has more. A maximum follower count is **not documented**.

**Status:**
- HL now calls these "legacy" and says HyperEVM vaults via CoreWriter are "a strict improvement".
- Scale is small: about $108M TVL outside HLP, across 3,100 open vaults.

**Use for ValueDesk:** "copy a leader" can be implemented as "deposit into the leader's own HL vault". It is O(1) in orders, but it only works for leaders who open a vault and accept the 10% economics.

### 3.5 HyperEVM + CoreWriter + read precompiles

**Verified live** (chain id `0x3e7` = 999, `https://rpc.hyperliquid.xyz/evm`):
- `eth_getCode(0x3333…3333)` returns bytecode with selector `0x17938e13` (`sendRawAction(bytes)`), so **CoreWriter is live**.
- `eth_call 0x…0807(BTC=0)` returns `0xced74` = 847,220 → /10^(6−5) = **$84,722** (BTC oracle).
- `eth_call 0x…0809` returns L1 block 1,160,502,682.
- `eth_call 0x…0800(user=the sub-account, perp=0)` returns **szi −44.39107 BTC**, entry notional $3.754M, leverage 5. That is a **third party's live position read from a contract**.
- `eth_call 0x…080f(dex=0, user)` returns accountValue **$7,591,995.77**, matching `clearinghouseState`.

**Documented** (`interacting-with-hypercore.md`, `interaction-timings.md`, `dual-block-architecture.md`, `activation-gas-fee.md`):
- Precompiles start at `0x…0800`: position, spot balance, vault equity, withdrawable, delegations, mark/oracle/spot px, L1 block, perp/spot/token info, BBO, account margin summary (`0x80f`), `coreUserExists` (`0x810`).
- Gas is `2000 + 65*(in+out)`. Values equal HyperCore state as of EVM block construction.
- **CoreWriter:** about 25k gas burned, about 47k per basic call. Encoding is `0x01 | actionId(3 bytes) | abi.encode(...)`.

| ID | Action | Fields |
|---|---|---|
| 1 | Limit order | `(uint32 asset, bool isBuy, uint64 limitPx·1e8, uint64 sz·1e8, bool reduceOnly, uint8 tif{1 Alo,2 Gtc,3 Ioc}, uint128 cloid)` (**no builder field**) |
| 2 | Vault transfer | – |
| 3–5 | Staking | – |
| 6 | Spot send | – |
| 7 | USD class transfer | – |
| 8 | Finalize EVM contract | – |
| **9** | **Add API wallet** | `(address, string name)` ("If the API wallet name is empty then this becomes the main API wallet / agent") |
| 10 / 11 | Cancel by oid / cloid | – |
| **12** | **Approve builder fee** | – |
| 13 | Send asset | – |
| 15 | Borrow/lend | – |
| 16 | Set abstraction | – |
| 17 | Outcome ops | – |

**CoreWriter constraints (documented):**
- **"Order actions and vault transfers sent from CoreWriter are delayed onchain for a few seconds"**, to remove any latency edge over the L1 mempool. They appear twice in the explorer: enqueue, then execution.
- Order: L1 block → EVM block → EVM→Core transfers → CoreWriter actions.
- The contract's Core account must exist **before** the EVM block. New Core accounts pay a 1-USDC activation fee, and unactivated accounts cannot send CoreWriter actions.
- EVM **small blocks every 1 s with 3M gas**; big blocks every 60 s with 30M gas. The on-chain mempool accepts only the next 8 nonces per address.
- Third-party audits and teams stress that **CoreWriter actions are not atomic**: an order can fail on Core while the EVM transaction succeeds, with no callback (QuillAudits, Chainstack, Trading Strategy).

### 3.6 Can a HyperEVM vault contract copy-trade for depositors trustlessly? (inferred design analysis)

**Option A: fully on-chain mirror ("trustless").**

Mechanism:
- An ERC-4626 vault per leader (or per leader set) holds USDC on its own HyperCore account.
- A permissionless `sync(asset)` does the following:
  1. Read the leader's `szi` via `0x800` and the leader's `accountValue` via `0x80f`.
  2. Read its own position and account value.
  3. Compute `target = leader_szi × own_AV / leader_AV`, clamped by vault risk limits.
  4. Take a slippage bound from `0x807`/`0x806` or `0x80e` (BBO).
  5. Emit a CoreWriter IOC order (action 1, tif 3).
- Anyone can call `sync`, so keeper liveness is the only off-chain dependency. A small bounty is possible.
- Deposits and withdrawals are handled in the contract. Withdrawals reduce positions proportionally and then send USDC via action 6/13.

Constraints:
- **Lag** is ≥1 EVM block (1 s) plus the "few seconds" CoreWriter delay: **about 2–6 s behind the leader** (estimate; measure on testnet).
- IOC slippage is exposed, and failures are silent, so the next `sync` must reconcile.
- There is **no builder fee** on CoreWriter orders. Monetize with a contract-level management or performance fee.
- EVM gas is limited: 3M gas per small block holds at most about 60 CoreWriter calls network-wide. Multi-asset leaders need several calls.
- It only works for leaders whose trades are slow relative to a few seconds. Swing and position traders are fine; scalpers and HFT/market makers are not.

**Option B: hybrid (contract custody + off-chain agent).**
- The contract calls CoreWriter action 9 to register a named API wallet held by the ValueDesk executor.
- The executor trades the vault's Core account at API latency (§4) and can attach builder codes, since the contract can self-approve via action 12.
- The contract still enforces deposits, withdrawals, fee accounting and an on-chain kill switch that re-registers or rotates the agent.
- Trust: the agent cannot withdraw but **can trade badly**, including self-dealing against a colluding account. Bound it with TEE attestation, an on-chain allowed-asset list checked ex-post, and max drawdown triggers. This matches the SoDEX hybrid in report 03.

**Option C: per-follower agent wallets (non-pooled).** This is what the whole market does today (§5). There is no contract risk. The costs are O(N followers) order fan-out and one-way netting with manual trades.

**Existing projects:**
- Searches found **no live trustless HyperEVM copy-trading protocol**.
- Found: ERC-4626 wrappers of HyperCore vaults (`adamocallaghan/hypervault`, a prototype).
- Found: Trading Strategy's Lagoon "vault of vaults" on HyperEVM. It uses CoreWriter vault transfers, reports 500+ rebalances and 4,000+ bridged transactions, is **throttled to $5k/day deposits** pending audit, and calls the Core↔EVM interface "brittle".

---

## 4. Order rate limits and latency

**Per follower (address).**
- The budget is a 10k buffer + 1 per USDC traded. A follower who copies a $500 order gains 500 requests, so budgets only bind for micro accounts or cancel-heavy strategies.
- Top-ups: `reserveRequestWeight` at $0.0005 per request, and it can target another user.
- Open orders: 1,000–5,000.

**Per ValueDesk egress IP.**
- REST: 1,200 weight/min, and each follower order costs 1 (batching is per account).
- WS: 2,000 messages/min and 100 in-flight posts.
- **So about 20 orders/s sustained per IP, or 100 in flight** (inferred).
- A 1,000-follower burst on one leader trade needs about 10 egress IPs to finish in about 1 s, or a pooled vault/sub-account model (O(1) orders).
- Priorities: the leader's own sub-accounts; ALO and cancels are prioritized over IOC/GTC in each block.

**Where things are:**
- Foundation node: AWS `apne1-az1`.
- Seed peers: 22 of 25 in Japan.
- The node README: "For lowest latency, run the node in Tokyo."
- The API is behind CloudFront; the origin location is not disclosed (assumption: Tokyo).

**Latency numbers:**

| Item | Figure | Source |
|---|---|---|
| Blocks | "70 ms unix time bucket (usually corresponding to 1 block)" | documented, `priority-fees.md` |
| End-to-end, cancel / ALO | "~380 ms end-to-end" (API server + mempool inclusion + commit, "usually 2 blocks in pipelined HyperBFT") | documented, `optimizing-latency.md` |
| IOC priority fee | About 45 ms faster per 1 bp, over 0–8 bps (`p = 80000` = 8 bps), charged on filled notional in HYPE | documented |
| ALO queue position | Can be bought within a 400 ms window | documented |
| `/info` round trip from Germany | 237–290 ms for small queries; ~1.4 s for a 740 KB fills page | verified |
| Trade block `time` → WS receive in Germany | p50 815 ms raw. The local clock was 0.41–0.53 s off (w32tm vs time.cloudflare.com), so the true value is probably ~0.3–0.8 s. Re-measure with synced clocks from Tokyo | verified raw, corrected value inferred |

**Estimated copy latency from a Tokyo host** (inferred): leader fill committed → WS push (same block) → decide → IOC → commit (~2 blocks). That is **about 0.4–0.8 s** behind the leader's fill.
- `orderUpdates` shows resting leader limit orders *before* they fill, which allows pre-positioning or a "copy the limit" mode.
- Read-path speedups: a local node with `split_client_blocks` saves 70–150 ms, and gossip priority about 25 ms per slot.

**Co-location advice:**
- Run the copy engine in Tokyo.
- Keep one persistent WS per role and use WS `post` for orders.
- Use one agent per follower with an atomic ms-nonce.
- Use fast cancels.
- Consider priority fees only for large followers, since 1 bp buys about 45 ms.

---

## 5. How existing HL tools do it

| Tool | Data acquisition | Copy execution | Fees / notes | Confidence |
|---|---|---|---|---|
| **Hyperdash** | Own validator-colocated sentry infra; sells "Direct Sentry Peering" (99.99% uptime) | Trading terminal; copy via rankings and signals ("sub-50ms execution" marketing) | – | documented (hyperdash.com/sentry-node, HL peer list); execution details not verified |
| **HypurrScan** | Runs 2 mainnet root peers in Japan (13.230.78.76, 52.195.133.97), i.e. own nodes; partnership with Nansen | Explorer, no copy | – | documented (node README) |
| **ASXN** (hyperscreener) | Runs 2 root peers in Japan and sells sentry peering | Analytics only | – | documented |
| **Nansen** | "Nansen x HypurrCollective" root peers in Japan, i.e. own nodes; wallet labelling | Native HL perps trading in its dashboard (launched June 9) | – | documented / press (cryptobriefing) |
| **CoinGlass** | Not disclosed; publishes `/api/hyperliquid/whale-position` (> $1M notional) and `/whale-alert` | None | API plans | documented endpoint; source unknown |
| **HyperTracker (CoinMarketMan)** | Peering provider, i.e. own nodes | – | $179–1,999/mo API | documented |
| **Hydromancer** | Own nodes; Reservoir S3 | – | $300–2,500/mo | documented |
| **Copin** | Indexes about 700k traders across 20+ perp DEXes | **User creates an HL API wallet (up to 180 d) and pastes its private key into Copin**, then signs fee terms with the master | **0.05% of size when opening** a copy position | documented (docs.copin.io, guides) |
| **Hyperbot** (hyperbot.network) | Whale tracker (HL + Aster) | Web and Telegram copy trading | **0.1% per transaction** + subscriptions + $BOT token | third-party write-ups |
| **Katoshi** | – | API key generated on the user's device; master signs the builder-code approval | **0.01% perps / 0.10% spot** via builder code; "vault mode" 0% perps for 1 USDC/day; groups earn followers' fees | documented (katoshi docs, via search) |
| **HyperCopy** (hypercopy.xyz, open source) | HL API from the browser | Copies via an API key **inside the user's browser only** | Free | documented (GitHub) |
| **Dwellir sample bot** | gRPC `StreamFills` (every fill) from Dwellir nodes | Python SDK IOC orders | – | documented (blog) |
| **Trading Strategy vault-of-vaults** | – | HyperEVM Lagoon ERC-4626 → CoreWriter vault transfers into HL vaults | Throttled $5k/day pending audit | documented (blog) |
| **Native HL vaults** | – | Leader trades the vault | 10% profit share, 1-day lock-up | documented |

**Pattern.** Serious data players run or peer with Tokyo nodes. Every copy product uses per-user agent keys: server-held (Copin, Hyperbot), device-held (Katoshi, HyperCopy), or leader vaults. Monetization is builder codes or per-trade fees in the 1–10 bps range.

---

## Facts table

| # | Claim | Confidence | Source |
|---|---|---|---|
| 1 | WS `trades` includes `users:[buyer,seller]` on every trade (16,205 of 16,205) | verified | wss://api.hyperliquid.xyz/ws; `websocket/subscriptions.md` (WsTrade) |
| 2 | `trades` and `userFills` for the same fill arrive together (p50 Δ 0 ms, n=14) | verified | live WS test |
| 3 | `orderUpdates`, `userFills`, `userEvents`, `clearinghouseState` (~5 s), `openOrders`, `activeAssetData`, `webData3` work for any address; `webData2` is rejected | verified | live WS test |
| 4 | Tracked-user cap: docs say 10 per IP; live error "Cannot track more than 15 total users."; behaviour is per backend | verified (limit text); per-backend reading is inferred | `rate-limits-and-user-limits.md`; live test |
| 5 | Docs list 10 WS connections/IP, 30 new/min, 1,000 subscriptions, 2,000 msgs/min, 100 in-flight posts, 60 s idle close | documented | `rate-limits-and-user-limits.md`, `timeouts-and-heartbeats.md` |
| 6 | REST limit is 1,200 weight/min/IP; weights 2 / 20 / 60 (userRole); fills and orders add weight per 20 items; exchange costs 1+floor(n/40) | documented | `rate-limits-and-user-limits.md` |
| 7 | `userFills` returns ≤2,000 fills; `userFillsByTime` returns 2,000 per page and only the 10k most recent fills | documented + verified | `info-endpoint.md` L138/L223; live |
| 8 | Address limit: 10k buffer + 1 per USDC traded (`nRequestsCap` = `cumVlm` + 10,000) | verified | `userRateLimit` live; docs |
| 9 | `reserveRequestWeight` costs 0.0005 USDC per request and can pay for another user | documented | `exchange-endpoint.md` L973 |
| 10 | `/info` and WS allow any browser origin (ACAO `*`, WS 101) | verified | curl with Origin header |
| 11 | Leaderboard: 39.1 MB, 46,887 rows, hourly, CORS `*`, no gzip | verified | stats-data.hyperliquid.xyz/Mainnet/leaderboard |
| 12 | Leaderboard inclusion is AV ≥ $100k or all-time volume ≥ $10M | inferred | data analysis of the file |
| 13 | Leaderboard rows aggregate sub-accounts; `portfolio`/`clearinghouseState` do not | inferred (strong) | master $10.3k vs row $59.8M; 50 sub-accounts |
| 14 | 24 h volume: perps $7.17B + HIP-3 $2.45B + spot $0.19B ≈ $9.8B; OI $13.3B | verified | `metaAndAssetCtxs` |
| 15 | Trades/day ≈ 6–15M; about 2.2k unique addresses per 3 min | verified sample / inferred extrapolation | WS firehose |
| 16 | DAU averaged 51k over 30 days; the stats feed has been stale since 2026-04-03 | verified (feed content) | d2v1fiwobg9w6.cloudfront.net/daily_unique_users |
| 17 | `hyperliquid-archive` is requester-pays in us-east-1; `hl-mainnet-node-data` is requester-pays in ap-northeast-1 | verified | anonymous S3 requests (403 + region header) |
| 18 | `node_fills_by_block` is about 0.8–1.0 GiB/day lz4 (24.61 GiB over 30 d in June 2026) | third-party documented | github.com/bond-labs-dev/hyperliquid-data |
| 19 | Hydromancer Reservoir: free-to-use requester-pays Parquet in ap-northeast-1 with fills and daily position snapshots for all traders | third-party documented | hydromancer.xyz/resources/hyperliquid-historical-s3-archive |
| 20 | `builder_fills` daily CSV is public and free; schema verified | verified | stats-data …/builder_fills/{addr}/{date}.csv.lz4 |
| 21 | Non-validator node: 16 vCPU / 128 GB / 500 GB SSD, Ubuntu 24.04, Tokyo, ~100 GB/day logs | documented | github.com/hyperliquid-dex/node README |
| 22 | Agents: 1 unnamed + 3 named + 2 per sub-account; `valid_until` ≤180 d; cannot withdraw | documented + verified (validUntil, 88 agents) | `exchange-endpoint.md` L809; `extraAgents` |
| 23 | A new unnamed agent de-registers the existing unnamed agent; never reuse agent addresses | documented | `nonces-and-api-wallets.md` |
| 24 | Nonces: 100 highest per signer, within (T−2 d, T+1 d) | documented | `nonces-and-api-wallets.md` |
| 25 | Builder caps 0.1% perps / 1% spot; `f` in tenths of a bp; builder needs ≥100 USDC perps and standard mode; max 10 approvals per user; main wallet signs | documented | `builder-codes.md`, `account-abstraction-modes.md` |
| 26 | Live builder revenue: $24.5k/day at 5 bps on $49M; $28.8k/day at 9.8 bps on $29M (2026-09-24) | verified | builder_fills CSVs |
| 27 | Sub-accounts: 10 after $100k volume, +1 per $100M, max 50 | documented | `trading/sub-accounts.md` |
| 28 | Legacy vaults: 10% profit share, ≥5% leader stake, 1-day lock-up, validator perps only, 100 USDC minimum, "10k USDC gas fee" | documented | `for-vault-leaders-legacy.md` |
| 29 | Precompiles return any user's position (0x800) and account value (0x80f) on mainnet; CoreWriter is live at 0x3333… | verified | eth_call on rpc.hyperliquid.xyz/evm |
| 30 | CoreWriter orders and vault transfers are delayed "a few seconds"; the order encoding has no builder field; action 9 adds an API wallet; action 12 approves a builder fee | documented | `interacting-with-hypercore.md` |
| 31 | HyperEVM small block 1 s / 3M gas; big block 60 s / 30M gas; CoreWriter call ≈ 47k gas | documented | `dual-block-architecture.md`, `interacting-with-hypercore.md` |
| 32 | E2E ≈ 380 ms for cancel/ALO; about 45 ms per bp IOC priority; 70 ms block buckets | documented | `optimizing-latency.md`, `priority-fees.md` |
| 33 | Foundation non-validator is in `apne1-az1`; access needs 10k HYPE staked + maker tier 1 | documented | `foundation-non-validating-node.md` |
| 34 | Copin 0.05% on open size (user pastes an API-wallet key); Hyperbot 0.1%; Katoshi 0.01% perps via builder code | third-party documented | docs.copin.io; hyperbot.network write-ups; katoshi docs |
| 35 | No trustless HyperEVM copy-trading protocol found | inferred (negative search result) | web searches 2026-09-25 |

---

## Open questions (and how to verify them)

1. **Semantics of the WS tracked-user cap** (10 documented, 15 observed, apparently per backend).
   - Verify: from the future Tokyo host, open 10 connections × 15 users and count acks.
   - Also ask in the HL API Discord whether the cap is per IP or per server.
   - The answer sets how many egress IPs are needed for per-leader streams. The trades firehose avoids the issue.
2. **Exact extra weight per 20 items** for `userFills`, `userFillsByTime` and `historicalOrders`.
   - Verify: a controlled backfill loop that watches for HTTP 429.
3. **Can one agent address be approved by more than one master?** This is irrelevant if we use one agent per follower, but it matters for cost and key management.
   - Verify on **testnet** with two funded test accounts. That involves signed actions, so it needs the owner's go.
4. **CoreWriter delay in seconds, and failure semantics.**
   - Verify: deploy a toy contract on HyperEVM **testnet** and time the enqueue→execution entries in the explorer.
   - Needs the owner's explicit go, because it is a deployment.
5. **Legacy vault creation fee.** The docs now say 10k USDC; it was historically 100 USDC. Also: the maximum follower count (the API showed 100).
   - Verify: ask HL, or read `createVault` in the Python SDK.
6. **Current sizes of `hl-mainnet-node-data` prefixes.**
   - Verify: `aws s3 ls s3://hl-mainnet-node-data/node_fills_by_block/hourly/ --recursive --summarize --request-payer requester`.
   - This costs fractions of a cent in LIST requests and needs an AWS identity and the owner's go.
   - Similarly, `hydromancer-reservoir` sizes and schema.
7. **Leaderboard inclusion rule.** It is inferred; confirm by checking an account just below the thresholds.
8. **HL stats feed (`d2v1fiwobg9w6…`) is stale since 2026-04-03.** Is there a successor? Otherwise compute DAU ourselves from the trades firehose.
9. **Origin location of `api.hyperliquid.xyz`** behind CloudFront. Measure RTT from a Tokyo host against a local node's block times.
10. **Builder address identities.** The Phantom attribution for `0xb841…` is an assumption. Confirm via public builder lists (e.g. Hypurrscan builder pages).

---

## Recommendations for ValueDesk (Hyperliquid side)

1. **Discovery and analytics pipeline (cheap, no node at first):**
   - (a) Hourly pull of the leaderboard (46.9k notable accounts), re-served gzipped from our CDN.
   - (b) **One persistent WS consumer of `trades` for all perps, `xyz` and liquid spot.** Store every trade with both addresses. This covers 100% of fills at about 0.3–0.8 GB/day gzipped. Derive DAU, volume, "new whales" and per-address activity from it.
   - (c) Resolve addresses once: `userRole` (weight 60, cache forever), and `subAccounts` for masters. Treat leaderboard "trader" as master + sub-accounts, but **copy per sub-account**.
   - (d) Seed and reconcile positions with `clearinghouseState` (weight 2). Reconciling 5,000 leaders hourly costs about 10k weight/hour, which is trivial.
   - (e) Enrich shortlisted leaders only with `userFillsByTime` (PnL, fees, `dir`), within the 10k-fill limit.
   - (f) Historical backfill beyond 10k fills from `node_fills_by_block` or Reservoir Parquet, **pulled from within ap-northeast-1** so transfer is free and only request fees apply. Or accept about $0.09/GB egress, which is roughly $2/month of fills.
2. **Push per-trader detail reads to the browser.** HL allows any origin, so the user's IP budget pays. Our backend only serves aggregates and rankings.
3. **Copy engine placement:**
   - One persistent Tokyo host, IaC-defined, per the AWS hard rule. No per-test instances.
   - Subscribe `orderUpdates` and `userFills` for the most-copied ≤10 leaders per IP. Detect everyone else from the firehose, which is just as fast.
   - Add more egress IPs for order fan-out as followers grow. Each IP sustains about 20 orders/s and 100 in flight.
4. **Execution v1:**
   - Per-follower, freshly generated **named** agent with `valid_until` ≤180 d.
   - Plus `approveBuilderFee`, so onboarding needs 2 main-wallet signatures.
   - IOC with slippage bands, and HIP-3 asset-id support.
   - A reconciliation sweep that reads real positions and corrects drift.
   - `scheduleCancel` as a safety net.
   - An atomic ms-nonce per agent.
   - Warn followers about one-way netting with their manual positions. Offer sub-account mode to followers with ≥$100k volume.
5. **Monetization:**
   - Builder fee 3–10 bps on perps. Competitors charge 1–10 bps. The cap is 10 bps on HL, versus 20 bps on SoDEX.
   - Keep the builder address funded with ≥100 USDC perps in standard mode.
   - Handle the 10-approval limit in the UX (detect it via `approvedBuilders`).
   - Add a referral code for the 10% fee share.
   - Use the public `builder_fills` of competitors as market intelligence.
6. **Trustless track (v2, research only until the owner gives a go):**
   - A HyperEVM ERC-4626 "leader vault" that mirrors via precompiles and CoreWriter, is permissionlessly syncable, and has a contract performance fee. It suits swing leaders given the multi-second CoreWriter delay.
   - Or a hybrid in which the contract registers a ValueDesk agent via action 9 for API-latency execution with builder fees.
   - Validate delays and failure modes on **testnet only after explicit approval**, then audit.
7. **Own node: not in v1.**
   - It costs about $1k/month plus ops, grows about 100 GB/day and needs Tokyo hosting.
   - Revisit when we need unlimited `clearinghouseState` polling, order-status firehoses (`--write-order-statuses`) or sub-100 ms reads.
   - Paid peering is under $1k/month; bought data (Hydromancer or HyperTracker) runs $179–2,500/month.
   - If we run one, deploy it once as a persistent IaC box and never churn it.

---

### Sources

- HL docs (raw .md):
  - rate-limits-and-user-limits
  - info-endpoint
  - websocket/subscriptions
  - websocket/post-requests
  - websocket/timeouts-and-heartbeats
  - exchange-endpoint
  - nonces-and-api-wallets
  - asset-ids
  - trading/builder-codes
  - trading/sub-accounts
  - trading/fees
  - trading/account-abstraction-modes
  - referrals
  - hypercore/vaults (+ protocol-vaults, legacy leader/depositor pages)
  - historical-data
  - for-developers/nodes/*
  - optimizing-latency
  - priority-fees
  - hyperevm/interacting-with-hypercore
  - interaction-timings
  - dual-block-architecture
  - activation-gas-fee
  - llms.txt index at `https://hyperliquid.gitbook.io/hyperliquid-docs/llms.txt`
- Node repo: `https://github.com/hyperliquid-dex/node` (README).
- Live endpoints:
  - `https://api.hyperliquid.xyz/info`
  - `wss://api.hyperliquid.xyz/ws`
  - `https://stats-data.hyperliquid.xyz/Mainnet/{leaderboard,vaults,builder_fills/...}`
  - `https://d2v1fiwobg9w6.cloudfront.net/{daily_unique_users,daily_usd_volume,daily_trades,cumulative_new_users}`
  - `https://rpc.hyperliquid.xyz/evm`
- Third party:
  - `https://github.com/bond-labs-dev/hyperliquid-data`
  - `https://hydromancer.xyz/resources/hyperliquid-historical-s3-archive`
  - `https://hydromancer.xyz/resources/how-to-get-hyperliquid-data`
  - `https://docs.hydromancer.xyz/`
  - `https://docs.coinmarketman.com/endpoints/rate-limits-and-pricing`
  - `https://docs.coinglass.com/reference/hyperliquid-whale-position`
  - `https://hyperdash.com/sentry-node`
  - `https://docs.copin.io/features/decentralized-copy-trading-dcp/connect-hyperliquid`
  - `https://hyperbot.network/`
  - `https://katoshi.gitbook.io/katoshi-docs`
  - `https://github.com/artiya4u/hypercopy-xyz`
  - `https://www.dwellir.com/blog/hyperliquid-copy-trading-bot-python`
  - `https://dev.to/caelyn_moss/building-non-custodial-copy-trading-on-hyperliquid-the-parts-that-actually-hurt-171h`
  - `https://tradingstrategy.ai/blog/hyperliquid-vault-of-vaults`
  - `https://github.com/adamocallaghan/hypervault`
  - `https://cryptobriefing.com/nansen-integrates-hyperliquid-perps-trading/`
- Opentrade:
  - `README.md:90-92` and `server/src/routes/wallet.ts:43-47` describe the same "trade-only delegated key, like HL's agent wallet" model.
  - `NOTES.md:78` records SoDEX's matching 1,200 weight/min budget.
