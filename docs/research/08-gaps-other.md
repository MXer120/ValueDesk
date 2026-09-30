# 08 — Gap filler: trader enumeration and data volume (G3), builder-fee behaviour (G6), Tokyo latency (G8), Hyperliquid agent scope (G9), Hyperliquid trade count (G10)

Research date: 2026-09-25, 11:29–12:35 UTC. This report answers five gaps a critic found in reports 01–06. It also settles the contradictions that touch those gaps.

**How the work was done (all read-only):**
- **Public endpoints only.** I used REST GETs and info POSTs on SoDEX (`mainnet-gw`, `mainnet-data`, `clobscan-mainnet`, `sodex.dev`) and Hyperliquid (`api.hyperliquid.xyz/info`, `rpc.hyperliquid.xyz/explorer`, `stats-data.hyperliquid.xyz`), plus `eth_call` on `rpc.valuechain.xyz`.
- **Streams.** I captured the public trade WebSocket streams of both venues for 60 minutes (11:32–12:32 UTC).
- **Probes.** I ran two Globalping HTTP measurements.
- **Tokyo measurements.** Latency was measured on the owner's existing **apex-tokyo** box (AWS ap-northeast-1; chrony locked to Amazon Time Sync, offset about 1 µs). Your CLAUDE.md hard rule ("measure from the live box first") covers this.
  - On the box I ran about 45 HTTPS requests and 3 WebSocket connections for 75 s. Scripts were piped over stdin.
  - Nothing was written to disk, nothing was installed and no process was touched.
  - No instances were created or started.
- **One rejected POST per venue.** I sent an unsigned POST with an empty body `{}` (4 on SoDEX, 5 on HL) to time the write path. SoDEX rejects it with "X-API-Nonce is required", HL with 422. No signature was involved, so no order or action could result.
- **Nothing else was touched.** No signed requests, no deployments, no cloud resources, no requester-pays downloads. Nothing in the Opentrade directory was changed.
- **Rate-limit incident.** Cloudflare returned `error code: 1015` twice, each time for about a minute, on SoDEX per-account `/trades` requests. Both times my combined traffic to `*.sodex.dev` was about 2.5–3.5 requests/s. Details are in G3.5.

Raw outputs are in the session scratchpad (`g8/`): `capture_summary.json`, `sample_accounts.json`, `klines_1d.json`, `lastids.json`, `builder_hits.json`, `f226415_spot.json`, `scan_builder.json`, `hl_hist_sample.json`, `vt_tx.json`.

Confidence labels: **verified** = I observed it live today or read it in code. **documented** = official docs or SDK. **inferred** = reasoned from verified or documented facts. **assumption** = not checked.

---

## TL;DR

1. **(G3) The SoDEX leaderboard cannot enumerate traders.**
   - Every `window_type`/`sort_by` returns at most 1,000 rows. Page 21 is empty.
   - `sort_order=asc` just returns the same top 1,000 in reverse, not the bottom of the table.
   - So the union of all 8 lists is at most 8,000 wallets.
   - `total` = **134,605 in every window**. It counts wallets with any all-time volume, not a 30-day figure.
   - **The working enumeration path:**
     1. Account ids 1…230,775 → addresses via `POST sodex.dev/mainnet/chain/users/addresses` (500 per call, 462 calls).
     2. Per id, `mainnet-data…/perps/pnl/overview?account_id=` or `leaderboard/rank?wallet_address=&window_type=&sort_by=volume`. The rank endpoint works for **any** wallet, not only the top 1,000.
   - Verified on a random sample of 400 ids.
2. **(G3) Real SoDEX population, from that sample:**
   - ≈59 % of ids ever traded (≈136 k; this matches `total`). ≈24 % ever traded perps (≈56 k).
   - Wallets with non-zero volume: **30D ≈ 10.7–11.9 k, 7D ≈ 7.0–9.5 k, 24H ≈ 4.3–5.7 k**. These are bracketed by leaderboard ranks.
   - **496 distinct accounts traded in the measured hour.**
   - New accounts: **≈150–250 per day**. The dashboard and id growth agree; report 01's 50/day is too low.
3. **(G3) Historical volume and backfill cost:**
   - Trade ids advance by exactly 1 per print (38,323 prints = 38,323 ids over one hour, zero gaps). The sum of the latest ids gives **≈159 M lifetime prints** (perps 119 M, spot 40 M), i.e. ≈318 M fill-sides.
   - Kline `n` (trades per candle) only exists from 2026-06-12 onward. It gives 71.9 M prints since then and ≈786 k/day over the last 30 days.
   - **≈90 % of fill-sides involve four accounts** (1002, 23342, 2140, 1001). The organic history is only ~15–35 M fill rows, under 1 GB compressed.
   - A full per-account REST backfill is ≈315 k requests (≈8 M weight). That is **≈1 IP-day at the live 6,000 weight/min, ≈4.6 IP-days at the documented 1,200, and ≈2.4 IP-days if the Cloudflare request-rate ceiling (~1.5 req/s) binds**. The last case is what actually binds.
   - Cheaper route: PnL/volume for everyone from the data host (≈287 k requests, ≈1–2 days at 1.7–3 req/s). Then fills only for the ≈12 k 30D-active accounts (≈36 k requests, ≈7 h).
4. **(G6) SoDEX builder fees are additive, and they are charged on maker fills too. Verified on real spot fills.**
   - Wallet 226415 (approved builder 223169) sent spot orders carrying `builder:{id:223169, fee:100}`.
   - Every one of its 159 sell fills was charged **exactly base + 10.0 bp**: taker 6.5 → 16.5 bp; maker 3.5 → 13.5 bp. Its 155 buy fills were charged base only.
   - **REST fill rows have no `builderFee` field.** The builder fee is folded into `fee`. Reconciliation must use `fee − base-rate × notional`, not `builderFee`.
   - No builder-tagged **perps** order exists in any sample (0 in 2,095 perps order txs over 24 h, and 0 among the approved wallets' perps orders). So perps behaviour is still documented-only.
   - **Builder 223169 is almost certainly SafePal wallet's SoDEX integration.** All 4 approving wallets hold a key named `safepal-<12 hex>` that expires in 2100. This is inferred.
5. **(G6, HL) On Hyperliquid, builder fees are also charged on maker fills, and on HIP-3 at the same rate.** Phantom's builder charges 5.00 bp on main and HIP-3, taker and maker (2026-09-24 `builder_fills`, verified). HIP-3 was **15.6 % of builder fills** across 15 builders.
   - **Correction to report 06:** HL docs say "builder codes override referral codes for that order". Referral and builder income do **not** stack on the same order.
6. **(G8) Latency measured from apex-tokyo:**
   - **SoDEX:** WS trade push arrives **p50 64 ms / p90 89 ms after the appchain trade time** (perps; server-side `E−T` 55 ms plus 8.8 ms network). Spot p50 28 ms.
   - SoDEX WS ping RTT 13.6 ms. REST keep-alive RTT 16–34 ms, and the POST path to the order route is the same (16–34 ms).
   - **The SoDEX origin is in the Tokyo area** (verified). Globalping TTFB is Tokyo min 17 / median 24 ms against Osaka 23 / 46 ms, and cf-ray is `NRT`.
   - **HL:** trade push p50 **236 ms** after block time. WS ping RTT 3.8 ms. `/exchange` rejection RTT 3 ms.
   - Estimated leader-fill → follower-order-at-gateway: SoDEX ≈75–110 ms, HL ≈245–300 ms. The signed-order acknowledgement is still unmeasured.
7. **(G9) HL agent keys are not trade-only.**
   - The official Python SDK signs `vaultTransfer`, `subAccountTransfer`, `subAccountSpotTransfer`, `createSubAccount`, `setReferrer` and `updateIsolatedMargin` as **L1 actions**. That is the agent-signable path (verified in code, commit 2fdb18f, 2026-06-04).
   - Withdrawals and sends are user-signed, and the docs add explicit "(agent)" variants only for user-signed categories.
   - So an agent can very probably deposit a follower's USDC into an **arbitrary vault** (inferred). The public explorer attributes agent transactions to the account, not the signer, so this cannot be proven read-only.
   - One agent can serve only one master (inferred from the signing model).
8. **(G10) Hyperliquid runs ≈5.4 M trades per day, not 6–15 M.**
   - The 60-minute capture of 445 markets (100 % of 24 h notional) saw 394,457 trades: 80 % main perps, 15 % HIP-3, 5 % spot. The time-extrapolated rate is 9.5 M/day.
   - That hour ran at **1.76× the day's average notional**. Normalising by notional, or dividing $10.08 B by the $1,877 mean trade, gives **≈5.4 M trades/day ≈ 10.8 M fills/day**.
   - Report 02's 90-s sample included ≈10 k snapshot trades. On subscribe HL sends ≈30 recent trades per coin; I dropped 13,343.
   - **17,317 distinct HL addresses traded in the hour.**
   - `userFillsByTime` reaches full history for ~75 % of hour-active users. It is truncated at 10 k fills for ~25 % (60 % of the most active).
9. **Rate limits (SoDEX).**
   - In one 60-s window I consumed 1,588 weight with every call accepted. So **the documented 1,200/min is not enforced**; the live budget is the 6,000/min counter in `x-ratelimit-*`.
   - The practical ceiling is Cloudflare's request-rate rule (`1015`), not weight.
   - An unsigned POST to `/perps/trade/orders` costs weight 1. Its response carries `access-control-allow-origin: *`, so CORS applies on the real POST route, not just the preflight.

---

## G3 — Enumerating every SoDEX trader, and the real data volume

### G3.1 Why the leaderboard crawl fails (verified)

| Request (`mainnet-data.sodex.dev/api/v1/leaderboard`) | Result |
|---|---|
| `window_type=24H&sort_by=volume&page=20&page_size=50` | ranks 951–1,000; rank 1,000 = $71.01 24H volume |
| `…&page=21` | `items: []`, `total: 134605` |
| `…&sort_order=asc&page=1` | ranks **1000, 999, 998 …**: the top 1,000 reversed, not the bottom of the table |
| `window_type=ALL_TIME&sort_by=pnl&sort_order=asc` | rank 1,000 = +$95.88 PnL: again the top 1,000 reversed, so losers are never listed |
| `total` in 24H / 7D / 30D / ALL_TIME | 134,605 in all of them |

- **Consequence:** the most the list endpoint yields is the union of 4 windows × 2 sorts × 1,000 rows, i.e. **≤8,000 wallets**.
- The 2,693-page crawl in reports 01 and 04 is impossible.
- Report 06's "134,605 wallets in the 30D window" is wrong. It is the all-time population (see G3.2).

**What does work:**
- `GET /api/v1/leaderboard/rank?wallet_address=<addr>&window_type=<W>&sort_by=volume` returns `{found, item:{account_id, pnl_usd, volume_usd, rank}}` for **any** wallet in the population.
  - Verified: rank 128,553 was returned for a wallet under the default sort.
  - Without `sort_by` the rank is by PnL. With `sort_by=volume` it is by volume.
- `GET /api/v1/perps/pnl/overview?account_id=<id>` returns `{cumulative_pnl, cumulative_quote_volume, unrealized_pnl, first_trade_ts_ms}` keyed by **account id**, so no address is needed.

### G3.2 Population and activity (verified sample, inferred totals)

**Method:**
- 400 uniformly random ids in [1000, 230774] (seeded).
- Resolved in **one** bulk call. All 400 returned an address.
- For each id: `pnl/overview`, plus `leaderboard/rank` for ALL_TIME, 30D, 7D and 24H (sort_by=volume) on the data host.
- Also `GET /api/v1/user/{addr}/ratelimit` on the gateway.
- 2,003 data-host calls at ≈1.7 req/s (330 ms pause + ≈270 ms latency): 2,000 × HTTP 200, 3 × HTTP 503, p50 273 ms from Germany. 400 gateway calls at 0.67 req/s: all 200.

| Quantity | Sample | Estimate for all ids (≈229.8 k ids ≥1000) | Notes |
|---|---|---|---|
| Account ids issued | — | **230,775** (next id 230,776 at 12:15 UTC; bulk resolver returns up to 230,775) | `eth_call 0xab00c0da` / `0x1c54e565` on `0x0101…0101` |
| In leaderboard population (`found`, ALL_TIME volume > 0) | 237/400 = 59.3 % | **≈136 k (95 % CI 125–147 k)**, matching `total` 134,605 | So `total` = wallets that ever traded (spot or perps) |
| Ever traded perps (`first_trade_ts_ms` > 0) | 97/400 = 24.3 % | **≈56 k (46–66 k)** | So ~40 % of the population traded spot only |
| `cumulativeTxNum` > 0 (any signed action) | 284/400 = 71 % | ≈163 k | Includes non-trading actions |
| Sum of `cumulativeTxNum` | 25,430 | ≈14.7 M non-MM actions lifetime | Heavy tail: p50 6, p90 43, p99 1,362 actions per account |

**Active wallets per window.** Three independent estimators, all verified data:

| Window | Share of random ids with volume > 0 | Rank bracket from the sample (max rank of an active wallet … min rank of a zero-volume wallet) | Order-statistic estimates | **Best estimate** |
|---|---|---|---|---|
| 24H | 10/400 (2.5 %) → ≈5.7 k | 3,944 … 5,730 | 4.3 k (max-rank) / 5.4 k (min-zero-rank) | **≈4.3–5.7 k wallets per day** |
| 7D | 13/400 → ≈7.5 k | 6,496 … 9,503 | 7.0 k / 9.2 k | **≈7–9.5 k** |
| 30D | 20/400 → ≈11.5 k | 10,727 … 11,913 | 11.3 k / 11.6 k | **≈10.7–11.9 k** |
| 1 hour (WS capture) | — | — | — | **496 distinct `bi`/`si` accounts**; 110–193 per 5 minutes |

- **Why the bracket works:** with `sort_by=volume`, every wallet with positive volume must rank above every zero-volume wallet.
- The leaderboard snapshot was taken hourly (`snapshot_ts` 10:00 UTC).
- A 24–48 h distinct-`bi`/`si` count from our own ingest would tighten the daily figure. This bracket is good enough for sizing.

**New accounts per day (resolves the 50/day vs 91–310/day contradiction):**
- `dashboard/users` summed over its whole history is **207,804** new users (2025-10-06 → 2026-09-24). Its September total is 5,762 (≈240/day). Monthly: Feb 52 k, Mar 92 k, Apr 36 k, May 12.8 k, Jun 2.7 k, Jul 0.6 k, Aug 1.1 k, Sep 5.8 k.
- Account ids tell the same story, dated by first trade (`pnl/overview`):
  - id 225,000 first traded 2026-09-01 19:41.
  - id 229,000 on 09-16.
  - id 230,700 on 09-24 19:16.
  - id 230,770 on 09-25 09:11.
- That is ≈5,775 new ids in 24 days (≈240/day), ≈210/day over 09-16…09-24, and ≈120/day over the last 14 h.
- **Verdict:**
  - The dashboard counts new accounts, and **150–250/day** is right.
  - Report 01's ≈50/day, extrapolated from EVM logs, is too low.
  - Report 05's "+1 in 12 minutes" and today's +2 between 10:26 and 12:15 are just quiet hours.

### G3.3 Historical prints (verified)

**Trade ids are sequential per symbol with no gaps (verified).**
- In the 60-minute capture, all 38,323 prints across every perps and spot symbol had `max(t) − min(t) + 1 = count`, with zero mismatches.
- For the 12 markets listed after 2026-06-12, the latest `t` equals the sum of kline `n` since listing (e.g. SPCX-USD 1,788,425 vs 1,788,439; the difference is prints between the two sweeps). So ids start at 1.
- Kline `n` (`GET /api/v1/{engine}/markets/{s}/klines?interval=1d&limit=1000`, field `n`) is **0 for every day before 2026-06-12** in all 107 markets that existed then. It is not a lifetime count. That also explains why earlier markets show `t/Σn` ratios of 1.2–6.6.

| Measure | Value | Source |
|---|---|---|
| **Lifetime prints** (sum of latest `t` over 125 markets with trades; `GET /api/v1/{engine}/markets/{s}/trades?limit=1`) | **159.0 M** (perps 118.95 M, spot 40.09 M) ⇒ **≈318 M fill-sides** | verified sweep, 12:00 UTC |
| Prints since 2026-06-12 (sum of kline `n`) | 71.9 M (perps 58.26 M, spot 13.67 M) | verified |
| Prints before 2026-06-12 (difference) | ≈87 M (2025-10-10 → 2026-06-11) | inferred |
| Prints per day, last 30 days | **≈786 k** (Sep 2026 avg 794 k; 09-24: perps 708 k + spot 148 k) | kline `n` |
| Prints in the measured hour | 38,323 (perps 32,208, spot 6,115) ⇒ 921 k/day pace | WS capture |
| Largest markets (lifetime prints) | BTC-USD 13.66 M, WSOSO spot 7.57 M, ETH-USD 5.69 M, SOL-USD 4.59 M, XAUT-USD 3.38 M | sweep |
| Dashboard volume = one-sided kline quote volume | 09-24 BTC-USD dashboard $54,984,451.32 = kline `q` $54,984,451.32 | verified; **not double-counted** (settles report 06 §1.4's suspicion) |

### G3.4 Who is on the prints: one agreed market-maker definition

The 60-minute capture (11:32–12:32 UTC, 38,323 prints, $5.18 M notional) gives these roles. `S` is the taker side, so the taker is `bi` when `S=BUY`, else `si`.

| Account | Share of prints | Share of notional | Role (by notional) | Fee rate (perps; `GET /{engine}/accounts/{addr}/fee-rate`) |
|---|---|---|---|---|
| **1002** `0x7Bb6…9DaeA` | **76.7 %** | 42.1 % | **99 % taker**, 122 symbols | tier 4: maker 0, taker 2.6 bp |
| **23342** `0x48D9…AD96` | 58.0 % | **97.4 %** | **93.7 % maker**, 89 symbols | tier 5, rebate tier 3: maker **−0.3 bp**, taker 2.4 bp |
| **2140** `0xd1C7…2BD1` | 37.2 % | 2.0 % | 61 % maker, 118 symbols, small tickets | tier 2: maker −0.1 bp, taker 3.2 bp |
| **1001** `0xC50E…7f7B` | 8.0 % | 0.3 % | 99.7 % maker (spot) | tier 1 |
| 1061 (SafePal user) | 1.4 % | 0.6 % | 78 % maker | tier 1 (3.6 / 1.0 bp) |
| 40695 | 1.35 % | 1.5 % | 95 % maker, 1 symbol | tier 0 |
| 52599 (24H volume rank 1) | 0.4 % | 2.0 % | 100 % maker, 1 symbol | tier 2, staking 2 |

**Reading:**
- 1002 is not a market maker. It is a high-frequency **taker** account that mostly hits 23342's quotes. The pair looks like affiliated or venue flow.
- 23342 is the liquidity provider on the other side of ~97 % of notional.
- Together, the four accounts (1002, 23342, 2140, 1001) sit on **90.0 % of fill-sides**.
- Organic accounts (492 in the hour) have only **10 % of fill-sides**. They are the taker on **51.4 % of notional**, while MM-taker flow is 48.6 %.

**Proposed single definition (replaces the four inconsistent lists in 01/05):**
- Tag an account `liquidity` if **either** of these holds over a trailing 24 h:
  - it is on ≥ 5 % of the venue's prints; **or**
  - it is on ≥ 1 % of prints with ≥ 90 % maker notional.
- Also tag system ids 998 and 999.
- **Today this yields {1002, 23342, 2140, 1001}. 40695 and 52599 become `maker-bot`**, a separate label.
- `liquidity` accounts are stored but excluded from leaderboards, analytics denominators and copy candidates. `maker-bot` accounts are shown but not copyable by default.
- Recompute daily, because ids may change.

**Revenue-model consequence (for report 06):**
- The headline volume is real one-sided volume, but about half of it is 1002's fee-tier-4 taker flow.
- For builder-fee planning, use **organic taker notional ≈ 50 % of dashboard perps volume**: ≈$50 M/day on a $103 M day, ≈$70 M/day at the 30D average of $143 M.
- DefiLlama's $285 k/30D in fees cannot be reproduced from these fee rates. Expected fees are ≈2.5–3 bp net per unit of volume, i.e. ≈$1.1–1.3 M per 30 days. Treat DefiLlama's "fees" as an undefined metric (inferred).

### G3.5 Backfill cost

**Limits that apply (verified today):**
- **Weight.** Per-account history pages cost `20 + floor(items/20)`, so a 1,000-row fills page costs 70 and a 500-row positions page 45 (documented, `api-rate-limits.md`). The live counter is **6,000/min**. I consumed **1,588 weight within one 60-s window** (47 kline calls, remaining counter 5,980 → 4,392), and every call returned HTTP 200 with `code:0`. The documented 1,200/min is therefore not enforced for GETs.
- **Request rate.** The practical ceiling is Cloudflare's `1015`.
  - It fired twice when my combined `*.sodex.dev` traffic reached ≈2.5–3.5 req/s. It targeted `…/accounts/{addr}/trades` while `markets/*` stayed 200, and lasted about 1 minute each time.
  - 400 `/user/{addr}/ratelimit` calls at 0.67 req/s never tripped it, even alongside ≈1.7 req/s to `mainnet-data`.
  - Plan for **≈1.5 req/s per IP** on the gateway.
  - The weight counter also moved during clobscan scanning, so it may be shared across `*.sodex.dev` hosts (inferred).
- **Data host (`mainnet-data.sodex.dev`).** No rate-limit headers. 2,003 calls at ≈1.7 req/s gave 3 × HTTP 503. Later, at ≈2 req/s during load, 4 of 14 ad-hoc calls returned `Request Timeout`. Plan for **≤1.5–2 req/s with retries**.

**Full per-account REST backfill (organic accounts only; never page 1002/23342/2140/1001):**

| Item | Requests | Weight |
|---|---|---|
| Id → address (bulk, 500/call) | 462 | ~20 each (not documented) |
| Fills pages: ≈136 k traded accounts × ~1.3 engines + ~2 % needing >1 page | ≈190 k | ≈5 M |
| Position history (perps, realized PnL): ≈56 k × 1.1 | ≈62 k | ≈1.5 M |
| Funding history (perps): ≈56 k × 1.1 | ≈62 k | ≈1.5 M |
| **Total** | **≈315 k** | **≈8 M** |

**Time on one IP:**
- **4.6 IP-days** at the documented 1,200/min.
- **0.9 IP-day** at the live 6,000/min.
- **2.4 IP-days if the Cloudflare request rate (≈1.5 req/s) binds.** That is the realistic figure.
- **Two or three egress IPs finish in about 1 day.**

**Rows and storage:**
- Organic fill rows ≈ 15–35 M. This is inferred from 10 % of today's 318 M lifetime sides as a lower bound, and ≈14.7 M lifetime non-MM actions; the airdrop months (Feb–Mar 2026) were more organic.
- At 11–30 B/row compressed (report 05's measurement) that is **<1 GB**.

**The cheaper route (recommended):**
1. `pnl/overview` for all 230,775 ids, plus `pnl/daily_stats` for the ≈56 k perps traders: ≈287 k requests on the data host, **≈47 h at the 1.7 req/s verified here** (≈27 h if 3 req/s holds). This yields cumulative PnL, volume, first trade and the daily PnL series for everyone, which is enough to rank and filter.
2. Fetch fills and position history only for the ≈12 k 30D-active accounts plus anything claimed or watch-listed: ≈36 k gateway requests, **≈7 h at 1.5 req/s**.

**Daily steady state:**
- Two gateway WS connections carry the whole print firehose with `bi`/`si` (≈0.8–0.9 M prints/day, ≈185 k organic fill-sides/day).
- Storage is ≈10 MB/day compressed for all prints.
- `accounts5min` shows about 110–190 distinct accounts per 5 minutes, so per-account REST refresh is small.

**Still open:** exact organic lifetime fill rows. This needs the full backfill, or summing `cumulativeTxNum` for all ids via `/user/{addr}/ratelimit` (weight 20 each, ≈230 k requests). A 24–48 h distinct-account count is best done by the production ingester.

---

## G6 — How SoDEX builder fees behave on real fills

### G6.1 Finding the fills (verified)

- **The 4 wallets approving builder 223169** were re-found by scanning `GET /api/v1/user/{addr}/builders` over the 30D-volume top 297 (same 4 as report 06):

  | Account | Address | 30D rank |
  |---|---|---|
  | 1061 | `0x0879a87d…bc84` | 65 |
  | 1395 | `0x162802da…29da` | 80 |
  | 226415 | `0x073e284e…5885` | 105 |
  | 225091 | `0x69d2a39d…bdf8` | 297 |

  Each approved `spot feeRate 500, perps feeRate 200`.
- **Who 223169 is (inferred, high confidence):**
  - All four wallets hold an API key named **`safepal-<12 hex>`** on both engines, with `expiresAt = 4102444800000` (2100-01-01).
  - The owner EOA `0x6dc379a4…8f0d` holds exactly 100 vUSDC in perps.
  - So builder 223169 is very likely **SafePal wallet's in-app SoDEX trading**, onboarded with `AddAPIKeyWithBuilder`. Hence the identical approvals.
  - Confirm with SafePal or SoDEX BD.
- **Orders:** clobscan `GET /api/v1/spot/transaction?account_id=226415&order_id=6541447279` returns `tx_json.payload.builder = {"fee":100,"id":223169}` on a `batchNewOrder` (sell 5 vETH @ 2780.4, GTC, clOrdID `s1003`, tx `0xc785ea4c…e730`).

### G6.2 Fee decomposition on the fills (verified)

`GET /api/v1/spot/accounts/0x073e…5885/trades?limit=1000` returned 314 fills (2026-09-09 → 09-23). The account's own `fee-rate` is taker 0.065 %, maker 0.035 %. **Every** fill falls into one of four exact rates:

| Fill type | n | Fee charged | Fee coin | Base rate | ⇒ builder part |
|---|---|---|---|---|---|
| Taker **SELL** | 70 | **16.50 bp** of notional | vUSDC (quote) | 6.5 bp | **+10.0 bp** |
| Maker **SELL** | 89 | **13.50 bp** | vUSDC | 3.5 bp | **+10.0 bp** |
| Taker BUY | 18 | 6.50 bp | base coin (vETH/vSOL…) | 6.5 bp | 0 |
| Maker BUY | 137 | 3.50 bp | base coin | 3.5 bp | 0 |

**Answers:**
1. **On top of the exchange fee?** Yes, additive. The rate charged is the order's `fee` (100 = 10 bp), not the approval's `maxFeeRate` (500).
2. **Charged on maker fills?** Yes. A resting GTC sell that filled as maker paid the full +10 bp.
3. **Both sides?** Spot: sell side only (quote-denominated fees), as documented. Perps: the documentation says both sides, but no perps builder fill was observable (see G6.3). The HL analogue charges maker and taker alike (G9.3).
4. **Where it shows up:** **inside `fee`.** The fill objects have **no `builderFee` key at all** (fields: `symbol, tradeID, orderID, clOrdID, side, price, quantity, fee, feeCoin, time, isMaker`). The same holds for account 1061's 1,000 perps and 1,000 spot fills.
   - Reports 01 and 06 say to "reconcile from `builderFee` on fills". That is not possible from REST (verified for spot).
   - Reconcile as `fee − accountBaseRate × notional` for fee-in-quote fills, from the WS `bf` field (documented; not observed here), or from builder-account balance deltas.
5. **Orders signed by keys added on-chain (EVM `0x8b53c6b9`):** **not resolved.**
   - The fee is applied at matching from the order's `builder` field (verified above), so the key's registration path should not matter (inferred).
   - To verify: recover the signer of a builder-tagged order from clobscan (EIP-712 `ExchangeAction`, as report 01 did), then check whether that key was registered by an EVM `addAPIKey` event or by an appchain `addAPIKey` action. clobscan lists `addAPIKey` as an appchain action for these accounts: 1395 has 37, 1061 has 32.

### G6.3 Adoption (verified)

- **Clobscan blocks:** 300 perps and 300 spot blocks, sampled every 3,700 heights over the last ≈24 h (5,151 + 2,111 txs; 2,095 + 990 order txs). **0 builder-tagged orders.**
- **This sample says little about organic use.** 94 % of perps txs are account 23342 and 92 % of spot txs are 1001.
- **The approved wallets' own orders** (clobscan `account/transactions`, then `transaction?tx_hash=`, `tx_json` parsed):

  | Wallet / engine | Sampled orders | Tagged |
  |---|---|---|
  | 226415 spot | 12 | **12**, all `223169:100`, buys **and** sells |
  | 225091 spot | 3 | **2**, `223169:100` |
  | 1061 perps + spot, 1395 perps + spot, 225091 perps | 53 | 0 |

  - The untagged wallets trade through their own `SODEX_API_KEY*` / `botmain01` keys.
  - Tagged **buy** orders produced fills charged at the base rate only (G6.2). This is verified evidence for "not the buying side of spot".
- **So builder codes are live but used by one integration (SafePal), on spot only, at 10 bp.** Report 01's "nobody uses builder codes" is wrong in fact, but right in magnitude.

**Implications for report 06:**
- The 13 bp copied round trip (4 + 4 + 5) assumes additive fees, and that is confirmed.
- "Opens-only" pricing is implementable because `builder` is per order. Leave it off reduce-only and close orders.
- Resting copy orders that fill as maker **still pay** the builder fee.

---

## G8 — Latency from the owner's Tokyo host; where the SoDEX origin is

**Host.** apex-tokyo is `ip-172-31-34-128.ap-northeast-1.compute.internal` (Graviton, 2 vCPU). Its chrony reference is 169.254.169.123 (Amazon Time Sync, stratum 2) with a system offset of about 1.5 µs. So one-way timings against server timestamps are trustworthy.

**Shared-IP note.** The box already held **4 established connections to SoDEX's Cloudflare IP 104.17.91.73**, so something on it already uses SoDEX. An executor there shares the per-IP REST and WS budgets with that workload.

### G8.1 SoDEX (verified)

| Measurement (from apex-tokyo) | Result |
|---|---|
| TCP connect to Cloudflare edge | 3.0–6.0 ms (cf-ray `…-NRT`) |
| TLS handshake | +9–17 ms |
| `GET /api/v1/perps/markets/mark-prices` (`cf-cache-status: DYNAMIC`), fresh connection TTFB | 29–45 ms |
| Same, keep-alive request RTT | **21.5–34 ms (median ≈24)** |
| `OPTIONS /api/v1/perps/trade/orders` (preflight) TTFB | 27–43 ms, 204 |
| **Unsigned `POST /api/v1/perps/trade/orders` `{}`**, keep-alive | **16–34 ms**; HTTP 200 + `{"code":-1,"error":"X-API-Nonce is required in header"}` + **`access-control-allow-origin: *`**; weight 1 (`x-ratelimit-remaining` 5999) |
| WS app ping (`{"op":"ping"}` → pong) RTT | perps **13.6 ms** p50 (13.1–16.6); spot 12.6 ms |
| WS `trade`: receive − `T` (appchain trade time) | **perps p10 40 / p50 64 / p90 89 / p99 282 ms** (n=652); spot p50 28 / p90 40 ms |
| of which `E − T` (server matching → push) | perps p50 **55 ms** / p90 81; spot 20 / 32 |
| of which receive − `E` (network, one way) | perps **8.8 ms** p50 (p99 11.9); spot 7.5 ms |

**Origin location (resolves the conflict among 01, 03, 04 and 05):**
- Two Globalping HTTPS runs to the same non-cacheable path gave:
  - **Tokyo** first-byte min 17 / median 24 ms (9 probes, CF NRT).
  - **Osaka** min 21–23 / median 46 ms (9 probes, CF KIX).
  - Seoul 51–54 ms, Hong Kong 66, Singapore 98, Frankfurt 265 ms.
- The apex-tokyo keep-alive RTT is 16–24 ms, and its one-way network time from the origin is 8.8 ms.
- **Verdict (verified): the SoDEX gateway origin is in the Tokyo metro area.** If it were in Osaka, KIX probes would beat NRT probes; they are ≈6–20 ms slower.
- The cloud provider is still hidden behind Cloudflare, and it does not matter.

### G8.2 Hyperliquid (verified)

| Measurement (from apex-tokyo) | Result |
|---|---|
| TCP to CloudFront (POP `NRT12-P8`) | 2.5–3.4 ms |
| `/info` `clearinghouseState`, keep-alive RTT | **16–25 ms**; fresh 27–81 ms |
| Invalid `POST /exchange` `{}`, keep-alive | **2.7–3.3 ms** → 422 from `nginx/1.22.1` (origin is next to the POP) |
| WS ping (`{"method":"ping"}`) RTT | **3.8 ms** p50 |
| WS `trades`: receive − block `time` | **p10 199 / p50 236 / p90 291 / p99 436 ms** (n=1,568; 15 coins incl. `xyz:`) |

The ≈200–240 ms is HL-internal: block time → commit → API fan-out. Network is ≈2 ms of it.

Report 02's 815 ms raw (Germany, clock +0.4–0.5 s) is consistent: 236 ms + ≈120 ms path + clock error.

### G8.3 Copy-latency budget from Tokyo

Measured parts are marked **M**; the rest are inferred.

| Step | SoDEX | Hyperliquid |
|---|---|---|
| Leader fill → public trade push received | **64 ms p50, 89 p90 (M)** | **236 p50, 291 p90 (M)** |
| Decision + signing (secp256k1, in process) | ≈1 ms | ≈1 ms |
| Order POST one-way to origin (half of keep-alive RTT) | **≈8–12 ms (M)** | **≈2 ms (M)** |
| **Leader fill → follower order at gateway** | **≈75 ms p50, ≈110 ms p90** | **≈240 p50, ≈300 p90** |
| Gateway → appchain/HyperCore inclusion | next block, ≈70–80 ms cadence (report 01) | "~380 ms end-to-end" for cancel/ALO (HL docs) |
| **Leader fill → follower fill (estimate)** | **≈120–200 ms** | **≈0.45–0.7 s** |

**Not measured, and what would measure it:**
- The real signed-order acknowledgement and fill timing. Place one minimum-size (10 USD) IOC order on each venue from apex-tokyo with the owner's go, and log `POST` → HTTP response → `accountTrade`/`userFills` push → `T`.
- The per-IP concurrency behaviour of signed POSTs.

Reports 01 (100–200 ms) and 03 (60–250 ms) fall within the SoDEX estimate above. Report 02's HL 0.4–0.8 s is confirmed toward the low end.

---

## G9 — What a Hyperliquid agent (API wallet) can actually do

### G9.1 Signing class of fund-moving actions (verified in code)

These come from `hyperliquid-dex/hyperliquid-python-sdk` `hyperliquid/exchange.py` at HEAD `2fdb18f` (last commit to the file 2026-06-04). `sign_l1_action` is the phantom-agent EIP-712 (`Exchange`, chainId 1337) that API wallets sign. `sign_user_signed_action` variants are `HyperliquidSignTransaction` typed data with `signatureChainId`.

| Action (`type`) | SDK signing | Moves value? |
|---|---|---|
| `vaultTransfer` (`vault_usd_transfer`, exchange.py:563–577) | **`sign_l1_action`** | **Yes: deposit into or withdraw from any vault address** |
| `subAccountTransfer` (:518–538), `subAccountSpotTransfer` (:540–561) | **`sign_l1_action`** | Yes, between the master and its own sub-accounts |
| `createSubAccount` (:454), `setReferrer` (:434), `updateIsolatedMargin`, `updateLeverage`, orders, cancels, `scheduleCancel`, TWAP | `sign_l1_action` | margin/positions |
| `hip3LiquidatorTransfer` (docs: no `signatureChainId` field) | L1-style | deposits to a HIP-3 backstop liquidator (multiples of 1,000) |
| `usdSend`, `spotSend`, `withdraw3`, `usdClassTransfer`, `sendAsset`, `approveAgent`, `approveBuilderFee`, `tokenDelegate`, `convertToMultiSigUser`, `userSetAbstraction` | user-signed (`sign_*_action` with chain id) | these need the master key |

**Supporting evidence:**
- The official docs say API wallets "sign on behalf of the master account or any of the sub-accounts" (`nonces-and-api-wallets.md`).
- The docs add **agent-specific** variants only where the normal action is user-signed: `agentSendAsset` ("Similar to send asset, but can be signed by an agent. Destination must match the source address"), `agentEnableDexAbstraction` and `agentSetAbstraction`.
- The `vaultTransfer` section (`exchange-endpoint.md` §"Deposit or withdraw from a vault") has no `signatureChainId`/`hyperliquidChain` field and no agent restriction.
- The third-party TS SDK (`nktkas/hyperliquid`, `src/api/exchange/_methods/vaultTransfer.ts`) also documents "Signing: L1 Action".

**Verdict (inferred, high):**
- A per-follower agent key can very probably call `vaultTransfer{isDeposit:true}` into **any** vault.
- An attacker holding it could create or lead a vault and deposit followers' USDC into it. The vault then trades against the attacker's other accounts, and followers can only withdraw after the 1-day lock-up.
- The barrier is the documented 10k-USDC vault creation fee, or collusion with an existing vault leader.
- Reports 02 and 03 ("cannot withdraw" ⇒ trade-only) understate this. Treat an HL agent key as **"can trade and can move funds into third-party vaults"**, and store it with the same care as a SoDEX ordinary key.

**Why it could not be proven read-only (verified):**
- `rpc.hyperliquid.xyz/explorer` `txDetails`/`userDetails` attribute agent-signed transactions to the **account**, not the signer. Querying known agent addresses (`0xeb94cef1…4ccc`, `0x1adb1eff…c011`) returns 0 txs.
- Sub-account orders show the sub-account as `user`.
- So the 15 HLP `vaultTransfer` txs in the last 3 h (`userNonFundingLedgerUpdates` of `0xdfc2…f303`) cannot be classified as agent-signed or master-signed.
- **To resolve:** a testnet run with the owner's go. Approve a named agent, then send `vaultTransfer{isDeposit:true, usd:5e6}` to a testnet vault signed by the agent. Or read signatures in `replica_cmds` (requester-pays S3, needs an owner go and an AWS identity).

### G9.2 Can one agent serve several masters? (inferred: no)

- An L1 action carries no user field. The server recovers the signer from the phantom-agent signature and must map it to exactly one account (`vaultAddress` only selects a sub-account or vault *of that user*).
- `userRole` for an agent returns a single `{"role":"agent","data":{"user":…}}`.
- So an agent address can belong to only one master. Approving the same address from a second master would either fail or re-bind it.
- **Plan one agent per follower** (report 02 already recommends this). The docs' guidance that nonces are "tracked per signer … shared" across sub-accounts supports it.

### G9.3 Builder codes on HIP-3 and on maker fills (verified)

- **Builders found:** 17 distinct builder addresses via `approvedBuilders` of 40 capture traders.
- **Files:** `builder_fills/{addr}/20260924.csv.lz4` from 15 of them (2 returned 403 = no file that day). Decoded with an LZ4-frame decoder; header `time,user,coin,side,px,sz,crossed,special_trade_type,tif,is_trigger,counterparty,closed_pnl,twap_id,builder_fee`.
- **Totals:** 126,694 builder fills and $151.3 M notional, of which **19,718 fills (15.6 %) and $17.1 M were HIP-3 coins** (`xyz:*`, `para:*`). Builder fees were $71.8 k, of which $8.2 k (11.4 %) came from HIP-3.
- **Rate is the same on HIP-3 and main:**
  - `0xb84168cf…ff80b` (report 02 attributes it to Phantom): 5.00 bp on main taker, main maker, HIP-3 taker and HIP-3 maker alike.
  - `0x9c87bb37…0ad9`: 10.25 bp main / 10.00 HIP-3.
  - `0x5aafc1f2…ede4`: 8.5 / 8.5.
- **Maker fills:** HL builder fees are charged on `crossed=false` fills as well (Phantom 145 main-maker + 25 HIP-3-maker fills, all at 5.00 bp).
- **Documented caveat:** "builder codes override referral codes for that order, and referral codes are disabled after the user trades $1B cumulative volume" (HL docs, staking-referral FAQ). **Referral rebates do not stack with our builder fee on the same order.** Report 06's "stack referral on top" applies only to referees' non-builder flow.

---

## G10 — Hyperliquid trade count, and enumerating traders beyond the leaderboard

### G10.1 One-hour capture (verified)

**Setup:**
- One connection with **445 `trades` subscriptions**: 178 validator perps, 150 HIP-3 markets over 10 dexes (`xyz, flx, vntl, hyna, km, abcd, cash, para, mkts, io`), and 117 spot pairs with non-zero volume.
- Together they cover **100.000 % of 24 h `dayNtlVlm`** ($7.458 B main + $2.442 B HIP-3 + $0.178 B spot = $10.08 B).
- The first message per coin was dropped (a snapshot), plus any trade older than start + 5 s. Trades were de-duplicated on `coin|tid`.

| Result (11:32–12:32 UTC) | Value |
|---|---|
| Snapshot messages dropped | 445 messages carrying **13,343 trades** (≈30 per coin) |
| Trades counted | **394,457** (main 315,038 = 79.9 %; HIP-3 59,049 = 15.0 %; spot 20,370 = 5.2 %); 0 duplicates |
| Rate | 109.7/s (4,147–16,778 per minute; a burst of 15 k/min at minutes 41–47) |
| Notional in the hour | $740.3 M (main $671 M, HIP-3 $60 M, spot $8.9 M) ⇒ $17.8 B/day pace = **1.76× the 24 h average** |
| Notional per trade | mean **$1,877**, median $164 |
| **Trades per day** | time-extrapolated 9.48 M (a busy hour); **normalised to the 24 h notional: 5.38 M**; $10.08 B ÷ $1,877 = **5.37 M** |
| Fills per day | ≈10.8 M (2 per trade) |
| Distinct addresses | **17,317 in the hour**; 2,900–3,600 per 5 minutes (6,510 in the burst). 4,639 traded once; 939 traded >100 times; 114 traded >1,000 times |

**Verdict:**
- **HL ≈ 5.4 M trades/day (≈10.8 M fills) at today's $10 B/day**, with hours at 2× that.
- This agrees with report 05 (4.8–4.9 M) and cryptostruct (5.01 M/day, 30 days to 09-22).
- Report 02's "6–15 M" came from short samples in busy periods, and its 90-s sample of 16,116 trades included ≈10 k snapshot trades (341 subscriptions × ≈30). Corrected, that sample is ≈6 k trades in 90 s ≈ 5.8 M/day.
- **Size ingest for 5.5 M trades/day on average and 20 M/day peak rate** (≈230/s).

### G10.2 How much history `userFillsByTime` reaches (verified sample)

**Method:**
- 40 addresses from the capture, stratified by trades in the capture window: low (1–2) 20 of 5,092; mid (3–20) 10 of 4,305; high (>20) 10 of 1,674.
- Each paged with `userFillsByTime startTime:0` in 2,000-row pages, up to 5 pages, spaced 7 s apart.

| Stratum | Truncated (hit the 10,000 cap) | Median reachable fills |
|---|---|---|
| low | 2/20 (10 %) | 183 |
| mid | 3/10 (30 %) | 3,334 |
| high | 6/10 (60 %) | 10,000 |
| **Weighted over hour-active users** | **≈25 %** | — |

- About 75 % of active HL traders have complete fill history through the free API (first reachable fills went back to 2024-11 … 2026-09).
- The heaviest quarter needs another source. Those accounts dominate volume, so for PnL analytics of the top traders the free API is not enough.

### G10.3 Enumerating HL traders beyond the 46,887-row leaderboard

| Route | Coverage | Cost | Confidence |
|---|---|---|---|
| Public `trades` firehose (as above) | every address that trades from now on; ≈17 k/hour, i.e. very likely 50–100 k/day (assumption: extrapolation from 17.3 k/h with repeat traders) | free; 1 connection, 445 of 1,000 subscriptions | verified (hourly) |
| HL leaderboard JSON | 46,887 notable accounts (AV ≥ $100 k or volume ≥ $10 M) | free, hourly, 39 MB | verified (report 02) |
| `userFillsByTime` per address | full history for ~75 % of active users; last 10 k fills otherwise | 20 + 1 per 20 items weight | verified |
| `node_fills_by_block` (S3 `hl-mainnet-node-data`, requester-pays, ap-northeast-1) | every fill since 2025-07-27 with both users → **all historical traders** | ≈0.8–1.0 GiB/day lz4 (third-party) → ≈420 GiB for 14 months: ≈$38 internet egress at $0.09/GB, ≈$0 transfer if read inside ap-northeast-1 (requests only) | documented-3p; needs the owner's go and an AWS identity |
| Hydromancer Reservoir (requester-pays) | daily snapshots of every trader's positions and account values, plus fills | S3 request and transfer cost; size not published | documented-3p |
| Own non-validator node (Tokyo) | everything live, no history | ≈$750–900/month (report 05) | documented |

**Recommendation:**
- Run the firehose from day one: it builds the address universe for free.
- Backfill the leaderboard plus every firehose address via `userFillsByTime`, only when the address is tracked.
- Buy history (`node_fills_by_block` read in ap-northeast-1) only when we need exact PnL for the truncated heavy traders.

---

## Contradictions and shaky claims: verdicts

| # | Claim (report) | Verdict | Evidence (this report) |
|---|---|---|---|
| 1 | Leaderboard crawl of 2,693 pages yields all 134,605 id↔wallet pairs (01, 04) | **False.** 1,000-row cap per window/sort; `asc` = the same 1,000 reversed | G3.1 |
| 2 | "134,605 wallets in the 30D window" (06) | **False.** `total` is the all-time population in every window; 30D active ≈10.7–11.9 k | G3.1–G3.2 |
| 3 | SoDEX registrations ≈50/day (01) vs dashboard 91–310/day | **Dashboard is right: ≈150–250/day** (ids 225,000→230,775 in 24 days; dashboard lifetime sum 207,804) | G3.2 |
| 4 | Market-maker filter lists differ (23342/1001 vs 1002 vs 2140) | **Single rule proposed.** Today it yields {1002, 23342, 2140, 1001}. 1002 is a taker account, not a maker | G3.4 |
| 5 | Dashboard volume double-counted (06) | **False.** Dashboard = one-sided kline `q` to the cent. About half is 1002's taker flow | G3.3, G3.4 |
| 6 | Builder fee "on top of exchange fees" (06 §1.3) vs "docs are silent" (06 §6.3) | **Additive, verified on spot, including maker fills.** Perps unobserved | G6.2 |
| 7 | "Nobody uses builder codes" (01) | **Nearly true.** One integration (SafePal-named keys, builder 223169) tags spot orders at 10 bp; 0 tagged orders in 3,085 sampled order txs; 4 approvals in the top 500 | G6.3 |
| 8 | "Reconcile from `builderFee`/`bf` on fills" (01, 06) | **Not possible from REST.** Fill rows have no `builderFee` key; the builder fee is inside `fee` | G6.2 |
| 9 | SoDEX origin Tokyo (01) vs "unknown"/"East Asia" (03, 04, 05) | **Tokyo metro, verified** (NRT beats KIX; apex-tokyo WS RTT 13.6 ms, one-way 8.8 ms) | G8.1 |
| 10 | Copy latency 100–200 ms (01) / 60–250 ms (03), never measured | **Push path measured:** 64 ms p50 leader fill → our socket; order-at-gateway ≈75–110 ms; follower fill ≈120–200 ms (estimate). Signed-order ack still unmeasured | G8.3 |
| 11 | One IP ≈1,200 orders/min because both venues allow 1,200 weight/min (03 §D.2) | **SoDEX:** 1,200/min is not enforced (1,588 weight in one window, all accepted); live counter 6,000; an order POST costs 1 ⇒ up to ≈6,000/min by weight. The binding limits are per-account 20 orders/s and 600/min, and Cloudflare's request-rate rule (unmeasured for POSTs). **HL:** 1,200/min stands (documented) | G3.5, G8.1 |
| 12 | Browsers can sign directly; hosting blockers are obsolete (04) vs only the preflight was verified (05) | **Partly upgraded.** The real POST route returns `ACAO: *` on an unsigned (rejected) request. A signed success response is still unverified, but it passes through the same route (inferred) | G8.1 |
| 13 | Data-API limits cited from `…/data-api/authentication-and-limits.md` (05) | **Wrong source.** That page is the SoSoValue OpenAPI (`openapi.sosovalue.com`, `x-soso-api-key`, 20 req/min, 100 k/month). `mainnet-data.sodex.dev` has no published limits; ≈1.7 req/s worked with 0.15 % 503s, and it later timed out under load | G3.5 |
| 14 | HL trades/day 6–15 M (02) vs 4.8–5.0 M (05) | **≈5.4 M/day** on a $10 B day; 02's sample included snapshots | G10.1 |
| 15 | HL agents "cannot withdraw" ⇒ trade-only (02, 03) | **Misleading.** `vaultTransfer`/`subAccountTransfer` are L1 (agent-signable) actions in the official SDK | G9.1 |
| 16 | Stack HL referral on top of builder fees (06) | **Documented not to stack** on the same order ("builder codes override referral codes") | G9.3 |
| 17 | Revenue scenarios on $140 M/day dashboard volume (06) | Use **organic taker notional ≈50 %** of it (≈$50–70 M/day) | G3.4 |
| 18 | Ordinary keys carry no `permissions` field (03 fact 26) vs `permissions` in the shape (04 §4.2) | **03 is right for every key observed.** Rows are `{name, type, publicKey, expiresAt}` only (4 accounts, 39 key rows). Whether the field appears when set is unobserved | `GET /user/{addr}/api-keys` |
| 19 | "Max 5 API keys per master" overridable only for MMs (01 fact 23) | **Weak.** Ordinary accounts hold 6–9 keys per engine (1061: 9 spot / 7 perps; 1395: 6 / 6), including sodex.com's `default/webkey/mobilekey/qrkey` and `safepal-*`. The cap's real scope is unknown (maybe only user-named keys, or only the REST path) | same |

Not addressed here, because they belong to the key/contract gap filler: the permission-mask semantics (01, 03 vs 06, 04 §10.6), the blast radius of an ordinary SoDEX key, the on-chain `addAPIKey` path and whether a contract can own a usable account.

---

## Facts table

| # | Claim | Confidence | Source |
|---|---|---|---|
| 1 | Leaderboard list endpoint returns at most 1,000 rows per window/sort; page 21 is empty; `asc` returns the same top 1,000 reversed | verified | `mainnet-data.sodex.dev/api/v1/leaderboard` (24H/ALL_TIME, volume/pnl, asc/desc) |
| 2 | `total` = 134,605 in every window = wallets with any all-time volume (59.3 % of random ids) | verified | leaderboard + 400-id random sample |
| 3 | `leaderboard/rank?wallet_address=&window_type=&sort_by=volume` returns rank and volume for any wallet in the population | verified | live, e.g. rank 128,553 |
| 4 | Account ids issued: 230,775 (next 230,776 at 12:15 UTC) | verified | `eth_call 0xab00c0da/0x1c54e565` on `0x0101…0101`; bulk resolver |
| 5 | ≈24 % of ids ever traded perps (≈56 k); ≈59 % ever traded (≈136 k) | inferred from a verified sample (n=400) | `pnl/overview`, `leaderboard/rank` |
| 6 | Active wallets: 24H ≈4.3–5.7 k, 7D ≈7–9.5 k, 30D ≈10.7–11.9 k; 496 accounts in one hour | inferred (rank bracketing) / verified (hour) | sample + WS capture |
| 7 | New accounts ≈150–250/day (September ≈240/day); dashboard lifetime sum 207,804 | verified | `dashboard/users`; first-trade dates of ids 225,000…230,770 |
| 8 | Trade ids increase by exactly 1 per print (38,323/38,323 over 1 h) | verified | WS capture `symIdCheck` |
| 9 | Lifetime prints ≈159.0 M (perps 118.95 M, spot 40.09 M); ≈318 M fill-sides | verified (sum of latest ids) | `GET /{engine}/markets/{s}/trades?limit=1` × 141 |
| 10 | Kline `n` exists only from 2026-06-12; 71.9 M prints since; ≈786 k prints/day over the last 30 days | verified | `klines?interval=1d&limit=1000` × 141 |
| 11 | Dashboard volume equals one-sided kline quote volume (no double counting) | verified | 09-24 BTC-USD $54,984,451.32 in both |
| 12 | 1002, 23342, 2140, 1001 are on 90 % of fill-sides; 1002 is 99 % taker on 77 % of prints; 23342 is maker on 97 % of notional | verified (1 h) | WS capture |
| 13 | Organic accounts are the taker on 51 % of notional | verified (1 h) | WS capture |
| 14 | Fee rates: 23342 maker −0.3 bp / taker 2.4 bp; 1002 0 / 2.6 bp | verified | `/perps/accounts/{addr}/fee-rate` |
| 15 | SoDEX REST: 1,588 weight consumed in one 60-s window without rejection; live counter 6,000/min | verified | 47 kline calls, `x-ratelimit-remaining` 5,980 → 4,392 |
| 16 | Cloudflare `1015` on `/accounts/{addr}/trades` at ≈2.5–3.5 req/s combined `*.sodex.dev` traffic; ≈1.5 req/s safe | verified (observed twice) / inferred (threshold) | this session |
| 17 | Builder fee is additive and charged on maker and taker spot sells: 16.5 / 13.5 bp vs base 6.5 / 3.5; buys unaffected although the buy orders also carry `builder` | verified | account 226415, 314 fills + 12/12 sampled orders `builder:{fee:100,id:223169}` |
| 18 | REST fill rows contain no `builderFee` key; the builder fee is inside `fee` | verified | fills of 226415 and 1061 |
| 19 | Builder 223169 is used by wallets holding `safepal-*` keys (expire 2100-01-01) → SafePal integration | inferred (high) | `/user/{addr}/api-keys` of all 4 approvers |
| 20 | 0 builder-tagged orders in 3,085 sampled order txs (300 perps + 300 spot blocks over ≈24 h) | verified | clobscan `block/transactions` |
| 21 | SoDEX origin is in Tokyo (NRT first-byte min 17 / median 24 ms vs KIX 23 / 46 ms) | verified | Globalping ×2; apex-tokyo |
| 22 | From apex-tokyo: SoDEX trade push p50 64 / p90 89 ms after `T`; `E−T` 55 ms; network 8.8 ms; WS RTT 13.6 ms; POST route RTT 16–34 ms | verified | apex-tokyo, chrony-synced |
| 23 | Unsigned POST to `/api/v1/perps/trade/orders` returns 200 + error envelope + `access-control-allow-origin: *`; weight 1 | verified | apex-tokyo curl |
| 24 | HL from apex-tokyo: trades push p50 236 ms after block time; WS RTT 3.8 ms; `/exchange` rejection RTT 3 ms; `/info` 16–25 ms | verified | apex-tokyo |
| 25 | HL ≈5.4 M trades/day (394,457 in 1 h at 1.76× average notional; mean $1,877) | verified (hour) / inferred (day) | 445-market capture |
| 26 | HL `trades` subscribe snapshots ≈30 trades per coin (13,343 over 445 coins) | verified | capture |
| 27 | 17,317 distinct HL addresses in one hour | verified | capture |
| 28 | ≈25 % of hour-active HL users exceed 10 k fills (history truncated via API) | verified sample (n=40, weighted) | `userFillsByTime` |
| 29 | Python SDK signs `vaultTransfer`, `subAccountTransfer`, `subAccountSpotTransfer`, `setReferrer`, `createSubAccount` with `sign_l1_action` (agent path) | verified (code) | `hyperliquid/exchange.py` @2fdb18f, lines 434–577 |
| 30 | HL explorer attributes agent txs to the account, so the signer cannot be seen | verified | `rpc.hyperliquid.xyz/explorer` userDetails/txDetails |
| 31 | HL builder fees apply to HIP-3 at the same rate (15.6 % of builder fills) and to maker fills | verified | `builder_fills/*/20260924.csv.lz4` (15 builders) |
| 32 | HL builder codes override referral codes for that order | documented | HL docs (staking-referral FAQ, `llms-full.txt` l.2072) |
| 33 | SoDEX "data-API limits" page is the SoSoValue OpenAPI (20 req/min, 100 k/month), not `mainnet-data.sodex.dev` | verified | `sodex.com/documentation/…/data-api/authentication-and-limits.md` |
| 34 | API-key rows carry only `name, type, publicKey, expiresAt`; ordinary accounts hold 6–9 keys per engine | verified | `/user/{addr}/api-keys` (4 accounts) |

---

## Open questions (and exactly how to close them)

1. **Perps builder-fee mechanics** (both sides? maker?).
   - Read-only: watch `builder_hits` wallets for a perps order carrying `builder` (clobscan `account/transactions?address=`, then `transaction?tx_hash=`). If one fills, apply the G6.2 decomposition to its perps fills.
   - Otherwise one tagged perps order of ≥ $10 from the owner's builder test account, with the owner's go.
2. **WS `bf` field presence.** Subscribe `accountTrade` for 226415. It trades spot every few days; the next sell fill shows whether `bf` is populated. Read-only, but it needs patience.
3. **Signed-order ack latency on both venues** from apex-tokyo. Needs one small IOC order per venue: the owner's go and funded accounts.
4. **Cloudflare `1015` threshold for gateway POSTs and history GETs.** Measure on the executor IP with the real workload, ramping 0.5 → 3 req/s and logging the first 1015. Or ask SoDEX for a builder allowance.
5. **HL agent `vaultTransfer`.** Testnet proof, as in G9.1, needs the owner's go. Ask in HL's API Discord in parallel.
6. **Exact SoDEX DAU.** Run a 24–48 h distinct `bi`/`si` count in the production ingester (2 WS connections).
7. **Builder 223169 identity.** Ask SafePal or SoDEX. It is the only incumbent builder and a partnership or competitive signal.
8. **Whether the SoDEX weight counter is shared across `mainnet-gw` and `clobscan`.** Log `x-ratelimit-remaining` on the gateway while clobscan runs alone.

## Recommendations for Valuescan

1. **SoDEX discovery pipeline:**
   - Bulk-resolve all 230,775 ids once (462 calls), then keep resolving new ids (~200/day) as they appear in `bi`/`si`.
   - Rank everyone with data-host `pnl/overview` (≈1–2 days once at ≤2 req/s), then refresh daily for 30D-active ids only.
   - Pull fills and position history only for the ≈12 k 30D-active plus claimed accounts.
   - **Drop the 2,693-page leaderboard crawl from the plans.**
2. **Apply the G3.4 `liquidity`/`maker-bot` rule at ingest**, and base revenue models on organic taker notional (≈50 % of dashboard volume), not headline volume.
3. **Budget SoDEX REST by request rate (≈1.5 req/s per IP), not weight.** Use two egress IPs for the one-off backfill. Never page the four liquidity accounts.
4. **Builder-fee accounting:** compute `builderFee = fee − baseRate(account, maker/taker) × notional` per fill (quote-denominated fills only), and cross-check against the builder account's balance deltas. Do not rely on a `builderFee` REST field.
5. **Pricing (report 06):** keep "5 bp on opening orders only" by omitting `builder` on reduce-only and close orders. Resting copy orders pay the fee when they fill as maker.
   - On HL, drop the assumption that referral stacks with the builder fee on routed orders.
6. **Executor placement:** Tokyo, next to both venues. apex-tokyo already sees SoDEX at ≈9 ms one-way and HL at ≈2 ms.
   - The box is small (2 vCPU, 3.8 GB, 116 MB free) and already runs a SoDEX workload that shares its IP limits. Put the executor on its own persistent, IaC-defined Tokyo instance **only after the EC2 block is lifted and the owner gives a go**. Do not churn instances.
7. **HL key custody:** treat per-follower agent keys as fund-moving (vault deposits). Encrypt them at rest, keep them in memory only in the executor, and alert on any `vaultTransfer` in a follower's `userNonFundingLedgerUpdates`.
8. **HL ingest:**
   - One firehose connection (445 subscriptions) is enough today.
   - Size storage for 5.5 M trades/day and bursts of 250/s.
   - Discard the per-coin snapshot on (re)subscribe.
   - Use `userFillsByTime` for full history of ~75 % of active users. Buy `node_fills_by_block` (read in ap-northeast-1) only for the heavy tail.
