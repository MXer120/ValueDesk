# 05 — Cheap data infrastructure for ValueDesk (indexing, analytics, users, hosting)

Research date: 2026-09-25 (Friday). This covers SoDEX (ValueChain) and Hyperliquid (HL), with room for more venues later.
Method: only public read endpoints were used. That means public WebSocket trade feeds (sampled for 4 and 6 minutes), REST info queries, `eth_call` on ValueChain, and 2026 pricing pages.
Nothing was signed, deployed or created. No cloud resources and no requester-pays downloads were used.
The raw measurements and scripts are in the session scratchpad (`a05/`). They are summarised below.

Confidence labels: **verified** = I observed it live or read it in the code; **documented** = official docs or pricing page; **documented-3p** = a third-party publication; **inferred** = calculated or reasoned from the above; **assumption** = a planning assumption that needs confirming.

---

## TL;DR

1. **The data is not huge unless you choose to make it huge.** Store trades, fills, equity snapshots and positions. Do not store order books or node logs. On that basis, ValueDesk's warm analytics store grows by about 12 GB per month for SoDEX plus HL combined, which is about 150 GB in year 1 after columnar compression. That fits on one €21 ARM VPS disk. The expensive path is HL order and book data (the HL node writes about 100 GB of logs per day). You only need it at the Scale tier, if ever.
2. **Measured volumes:**
   - **HL:** about 5.0 M trades per day (about 10 M fills, 2 per trade). I measured 4.8–4.9 M per day on main perps plus HIP-3; a third-party figure for the 30 days to 2026-09-22 is 5.01 M. That is about 272 B of JSON per trade, and **36 B per trade in Parquet/ZSTD** (21 B without the tx hash).
   - **SoDEX:** about 0.8–1.3 M trades per day. That is about 120 B of JSON per trade and **11 B per trade compressed**. About 85 % of SoDEX prints involve one market-maker account (id 1002).
   - **Accounts:** SoDEX has **230,773 accounts** (`getNextAccountId()` = 230,774 at 10:26 UTC) and 134,605 leaderboard rows. The HL leaderboard snapshot has 46,887 rows (39 MB JSON). HL reports about 1.84 M all-time users (third-party figure).
3. **The cheapest way to index everything is the public trade streams, and both carry the counterparties:**
   - The SoDEX `trade` WebSocket includes buyer and seller account ids (`bi`/`si`).
   - The HL `trades` WebSocket includes `users:[buyer,seller]`.
   - Together that is about 2 SoDEX connections and 2–3 HL connections per IP, with every trade attributed to every trader. No per-user subscriptions are needed; those are capped at **10 unique users per IP** on both venues.
   - The copy executor should use the same mechanism to detect leader fills.
4. **Recommended design: a tiered store with precomputed JSON.**
   - **Hot:** per-trader position and equity state in process memory, plus Valkey/Redis.
   - **Warm:** ClickHouse, single node at first, with materialized views that keep daily aggregates per trader. Rolling 1D/7D/30D/90D/ALL metrics are recomputed from those every 60 s.
   - **Cold:** zstd NDJSON or Parquet on Cloudflare R2 ($0.015/GB-month, zero egress).
   - **Serving:** Leaderboard and Explore are served as precomputed JSON from the Cloudflare CDN (`s-maxage` 30–60 s), which makes the API almost free.
   - **Venue numbers first:** use each venue's own PnL series (HL `portfolio` and the leaderboard; SoDEX data-API `pnl/daily_stats`) instead of reconstructing PnL.
5. **Hosting split:**
   - **Latency-insensitive work goes to Hetzner (EU):** indexing, analytics, API and WS fan-out. About 6× cheaper than AWS for equivalent compute, with 20 TB traffic included.
   - **Frontend and edge go to Cloudflare:** static assets are free and unlimited, WebSockets are proxied on all plans, and R2 has zero egress.
   - **Only the copy executor must sit in Tokyo** (next to HL, and very probably next to SoDEX). It should be one persistent, IaC-defined instance, never churned.
   - AWS EC2 is blocked on account 568311961884 since 2026-09-06, so plan the executor on AWS Tokyo only if that is lifted. Otherwise use a Tokyo VPS.
6. **Three costed stacks** (details in §5):
   - **Bootstrap:** about **$50–60 per month**.
   - **Growth:** about **$430–560 per month** (replicated ClickHouse, HA executors, managed Postgres).
   - **Scale:** about **$2.5–4.5 k per month** (own HL node in Tokyo, ClickHouse cluster, multi-region executors).
7. **New finding (verified today):**
   - **CORS:** the SoDEX gateway now answers CORS preflight for signed-write paths with `Access-Control-Allow-Origin: *` and allows `X-Api-Key`, `X-Api-Sign`, `X-Api-Nonce` and `X-Api-Chain`. Opentrade's DEPLOYMENT.md (Aug 2026) says a relay is required. If the actual POST response carries the same header, browsers can post signed orders directly, and the write relay becomes optional. Confirming that needs one real signed order, which requires the owner's go.
   - **Rate limit:** the live `x-ratelimit-limit` header is **6000** per minute, against the documented 1200.

---

## 1. Volume estimates

### 1.1 Hyperliquid

| Metric | Value | How obtained |
|---|---|---|
| 24 h notional, main perp dex | **$7.19 B** (178 active of 234 listed perps) | `POST /info {"type":"metaAndAssetCtxs"}`, sum of `dayNtlVlm` (verified) |
| 24 h notional, HIP-3 dexes | **$2.47 B** (`xyz` $2.41 B, 125 markets; `io` $26 M; `mkts` $21 M; others ≈0) | `perpDexs` + `metaAndAssetCtxs` with `dex` (verified) |
| 24 h notional, spot | **$0.19 B** (330 pairs) | `spotMetaAndAssetCtxs` (verified) |
| Trades per second, main perps | **47.8/s** (17,209 in 360 s, 10:17–10:23 UTC) | public `trades` WS, 178 subscriptions (verified) |
| Trades per second, `xyz` HIP-3 | **8.9/s** (3,193 in 360 s) | 109 subscriptions (verified) |
| Trades per second, main + `xyz` (second run) | **55.6/s** (13,290 in 239 s) | second capture (verified) |
| Trades per day | **≈4.8–4.9 M** measured (main + `xyz`; spot and small HIP-3 dexes add a little). Third-party figure for the 30 days to 2026-09-22: **150,304,852 trades = 5.01 M/day** across 557 instruments | time extrapolation (inferred) and cryptostruct.com (documented-3p) |
| Fills per day | **≈10 M** (each trade creates one fill per side) | inferred |
| Notional per trade | mean **$977**, median **$141** | capture (verified) |
| Unique addresses seen | 1,915 (main perps) + 485 (`xyz`) in 6 min; 1,896 in 4 min | capture (verified) |
| Leaderboard snapshot | **46,887 rows**, 39,091,455 B, served uncompressed from CloudFront/S3. `Last-Modified` 09:51 UTC; unchanged 36 min later, so it probably refreshes about hourly. | `GET stats-data.hyperliquid.xyz/Mainnet/leaderboard` (verified) |
| Leaderboard rows with activity | 8,357 (day) / 14,412 (week) / 19,136 (month) with `vlm > 0`; 20,697 with `accountValue ≥ $10k` | parsed snapshot (verified) |
| All-time users | about 1.84 M | datawallet / coinlaw (documented-3p) |
| Active perp traders | 263,666 (record, Aug 2026) | hokanews / cryptotimes (documented-3p) |
| Bytes per trade, as received | **272 B** JSON object; **371 B** on the wire including envelope (main perps) | capture (verified) |
| Fields per public trade | `coin, side, px, sz, time, hash, tid, users[2]` | WS payload (verified) |
| Fields per user fill (`userFills`) | adds `startPosition, dir, closedPnl, oid, crossed, fee, feeToken, builderFee` | HL info docs (documented) |

The measurement window was a Friday morning in UTC. Its notional ran at about half of the 24 h average ($15.45 M in 6 min, i.e. $3.7 B/day against $7.19 B). Extrapolating by notional would give about 8 M trades per day, and extrapolating by time about 4.9 M. The third-party 30-day figure (5.01 M/day) falls inside that range, so I use **5 M trades/day (10 M fills/day)** as the planning base and **15 M trades/day** as the 3× growth case.

### 1.2 SoDEX

| Metric | Value | How obtained |
|---|---|---|
| 24 h quote volume, perps | **$104.9 M** (91 markets; BTC $54.5 M, ETH $30.3 M) | `GET mainnet-gw.sodex.dev/api/v1/perps/markets/tickers` (verified) |
| 24 h quote volume, spot | **$1.49 M** (34 markets; WSOSO $1.07 M) | spot tickers (verified) |
| 30-day average | **$141.7 M/day**, from $44.9 M to $602.8 M (spikes on 09-11, 09-15, 09-18, 09-21, 09-23) | `GET mainnet-data.sodex.dev/api/v1/dashboard/volume?start_date=2026-08-25&end_date=2026-09-24` (verified) |
| Trades per second | perps **7.8/s**, spot **1.7/s** (6 min); **9.9/s** combined (4 min) | public `trade` WS with `symbols:[all]` (verified) |
| Trades per day | time extrapolation: **0.82–0.85 M**. By notional: perps 889 k plus spot 148 k = **1.04 M**. On an average-volume day: **≈1.2–1.4 M** | inferred |
| Notional per trade | perps **$110**, spot **$10** (many tiny prints) | capture (verified) |
| Concentration | account **1002** is on 2,025 of 2,372 prints (85 %); 23342 on 1,306; 2140 on 915 (market makers) | capture (verified) |
| Unique account ids | 93 (perps) + 6 (spot) in 6 min; 122 in 4 min | capture (verified) |
| Accounts registered | `getNextAccountId()` (selector `0xab00c0da`) returned **230,773** at 10:14 UTC and **230,774** at 10:26. `ownerOf(230773)` (selector `0x792713b8`) returns an owner; 230774 returns zero. So about **230.8 k accounts**; the lowest ids seen are 1001/1002. | `eth_call` to `0x0101…0101` (verified) |
| Leaderboard population | `total` = **134,605** for every window. The paged list is capped at **1,000 rows** (20 pages × 50); page 21 is empty. The hourly `snapshot_ts` was 10:00 UTC. Rank 1,000 in 24 H volume had only $71, so well over 1,000 accounts trade per day. | `GET mainnet-data.sodex.dev/api/v1/leaderboard` (verified) |
| Bytes per trade, as received | **119–122 B** JSON; **153–165 B** on the wire | capture (verified) |
| Fields per public trade | `E` (event ms), `T` (trade ms), `t` (id), `s`, `S` (aggressor side), `p`, `q`, **`bi`/`si`** (buyer and seller account ids). Delay `E − T`: median 48 ms and p95 78 ms (perps); median 21 ms (spot) | capture (verified); Opentrade `web/src/api.ts:197-216` |
| REST trade print | has **no** `bi`/`si`, so WS is the only attributable public source | Opentrade `web/src/api.ts:210-213` (verified in code) |

### 1.3 Data growth: raw vs compressed columnar

Compression was measured by writing the captured trades to Parquet with DuckDB 1.5.2 (ZSTD, types chosen the way ClickHouse would store them: addresses and hashes as binary, prices as Float64, time as Int64). The sample is small (13 k HL rows, 2.4 k SoDEX rows). A full day in one row group will compress somewhat better, so these figures are conservative.

| Encoding | HL bytes/trade | SoDEX bytes/trade |
|---|---|---|
| JSON object (as received) | 272–276 | 119–137 |
| NDJSON + gzip-6 | 56 | 21 |
| NDJSON + zstd-3 / zstd-19 | 48 / 37 | 21 / 14 |
| Parquet ZSTD, trade table with tx hash | **36.4** | **11.3** |
| Parquet ZSTD, trade table without hash | 20.7 | n/a |
| Parquet ZSTD, per-user fill table (2 rows per trade, sorted by user) | 14.7 per fill (29.4 per trade) | ≈10 per trade (inferred) |
| Parquet Snappy, trade table with hash | 43.9 | 17.5 |

The per-user fill row keeps `user, coin, is_buy, px, sz, t_ms, tid`.

Growth at the planning base (HL 5 M trades/day, SoDEX 1.2 M trades/day):

| Stream | Per day | Per month (30 d) | Per year |
|---|---|---|---|
| HL raw JSON | 1.36 GB | 41 GB | 497 GB |
| HL WebSocket ingress on the wire | ≈1.85 GB | ≈56 GB | ≈680 GB |
| HL cold archive (NDJSON zstd-3) | 240 MB | 7.2 GB | 88 GB |
| HL warm: trades with hash | 180 MB | 5.4 GB | 66 GB |
| HL warm: per-user fill projection | 147 MB | 4.4 GB | 54 GB |
| SoDEX raw JSON | 146 MB | 4.4 GB | 53 GB |
| SoDEX warm: trades plus per-user projection | ≈26 MB | 0.8 GB | 9.3 GB |
| SoDEX cold (zstd) | 25 MB | 0.76 GB | 9 GB |
| Snapshots: HL leaderboard (daily full, hourly top 5k), equity and positions hourly for about 10 k tracked traders, 1-minute candles for about 420 markets | ≈30 MB | ≈1 GB | ≈12 GB |
| **Total warm (ClickHouse)** | **≈385 MB** | **≈11.6 GB** | **≈140–160 GB** |
| **Total cold (R2)** | **≈270 MB** | **≈8 GB** | **≈100 GB** (R2 ≈ $1.50/month at year end) |

For comparison: an HL non-validator node "will generate around 100 GB of logs per day" by default. Raw book diffs and order statuses are "a substantial amount of data". Those are what would take this to 10–100×, and you only need them at the Scale tier.

Scenarios used in §2:
- **MVP:** ≈6 M trades/day, ≤200 GB warm, about 10 k DAU.
- **10×:** about 60 M rows/day (more venues, HL growth, order events), ≈1.5 TB warm per year, about 100 k DAU.
- **100×:** about 600 M rows/day (order- and book-level data from your own node), ≈15 TB per year, about 1 M DAU.

---

## 2. Storage and compute options

### 2.1 Monthly cost comparison (inferred from the 2026 pricing pages cited)

| Option | MVP | 10× | 100× | Notes |
|---|---|---|---|---|
| **ClickHouse, self-hosted on Hetzner** | **≈$25**: shares one CAX31 (8 vCPU ARM, 16 GB, 160 GB) at €20.99 with the rest of the stack | **≈$250**: 2× AX42 (€97.30 each, +€49 setup) replicated, plus 3× CAX11 Keeper (€5.99) | **≈$950–1,500**: 3× AX102 (€257.30) or 2× AX162-1 (€612.30), plus S3-disk tiering to R2 | Best $/performance. You run upgrades and backups (BACKUP to R2). |
| **ClickHouse Cloud** (AWS us-east-1 list prices) | **≈$170–190**: Basic 8 GiB 24/7 = $159.66 compute, plus storage $25.30/TB, plus backup at the same rate | **≈$1,000**: Scale 2×16 GiB example $986.92 including 1 TB; each extra TB +$50.60 including backup | **≈$2,500–6,000**: Scale large ($1,474) to Enterprise 2×64 GiB ($5,208), plus 15 TB × $50.60 ≈ $760 | Basic is capped at 1 TB and 8–12 GiB. $300 trial credit. Egress $0.102–0.151/GB. Scales to zero when idle, but this workload is never idle. |
| **Postgres + TimescaleDB** | self-hosted on the same box: $0 extra, with 2–4× CH's disk footprint (inferred); Tiger Cloud from $30 | ≈$250–1,000 (self-hosted AX42 or Tiger Cloud) | ≈$3,000+ (inferred) | Fine for users and configs. Weaker than CH for wide scans and top-N over millions of traders. |
| **DuckDB/Parquet on R2 (+ MotherDuck)** | **≈$0–3**: R2 storage (10 GB free) with DuckDB inside the app box; MotherDuck Lite is free (10 GB, 10 h Pulse) | ≈$560: R2 1.5 TB ≈ $22, plus MotherDuck Business $250, plus Standard $2.40/h × about 4 h/day | ≈$1,500–3,000 (inferred) | Excellent for cold archive and back-tests. Latency is too high for per-address pages under load (object-store reads). |
| **BigQuery** | ≈$0–50 if well partitioned (1 TiB/month query free; $6.25/TiB after; storage $0.02/GB logical) | $100–1,000+ | $1,000–10,000+ | Pay-per-scan penalises the "recompute every minute" and "per-address page" patterns. **Not recommended as the serving store.** |

The recommendation is **ClickHouse, self-hosted, single node for MVP**. It gives the best cost and the best fit: MergeTree plus materialized views are the natural shape for "rolling metrics per trader". Replicate it at Growth. ClickHouse Cloud is the "no-ops" alternative at roughly 7× the MVP cost.

### 2.2 Tiered data design

```
 venues ──► ingest (1 process per venue, Go/Rust/Node)
            │  SoDEX: 2 WS conns, channel "trade" symbols:[all 125]  -> bi/si account ids
            │  HL:    2-3 WS conns, "trades" per coin (~300-560 subs) -> users[buyer,seller]
            │  + REST pollers (rate-budgeted, event-driven)
            ▼
 HOT   in-process state + Valkey: positions, last equity, last fill per trader, open copy intents
       (≈50 k traders × ~1 KB ≈ 50 MB)
 WARM  ClickHouse
       trades_raw (MergeTree, ORDER BY (venue, symbol, ts))
       fills_by_user (projection or MV, ORDER BY (venue, user, ts))       ← address/Scan pages
       equity_snap / pnl_daily (ReplacingMergeTree)                        ← from venue APIs
       trader_day_agg (AggregatingMergeTree via MV): volume, trades, buys/sells,
           per-asset notional, realized pnl (where known), fees, max/avg leverage
       candles_1m (MV from trades)
 COLD  R2: hourly NDJSON.zst per venue (replayable), nightly Parquet per table;
       ClickHouse BACKUP + pg dump to R2. TTL move/delete in CH after 90-180 d if needed.
 SERVE precompute job (every 30-60 s): leaderboard/{venue}/{window}/{sort}.json (top 500),
       explore facets, trader-cards/{venue}/{addr}.json (top 10 k, every 5 min when changed)
       → served from origin RAM with Cache-Control: public, s-maxage=30, stale-while-revalidate=60
       → Cloudflare CDN (free) with Tiered Cache
```

**Metrics (all computed from the daily aggregates plus today's partial):**
- **Windowed PnL and ROI:** use the venue's own numbers. HL: leaderboard `windowPerformances` (`pnl`, `roi`, `vlm`) and `portfolio` (`accountValueHistory`, `pnlHistory`). SoDEX: data API `/api/v1/perps/pnl/daily_stats?account_id=` (daily cumulative PnL series) and `/pnl/overview` (`cumulative_pnl`, `cumulative_quote_volume`, `unrealized_pnl`, `first_trade_ts_ms`). These already include funding and fees, so we do **not** need to reconstruct them (verified: both return data for account 52599).
- **Max drawdown and Sharpe:** computed on the venue equity/PnL series. Sharpe = mean of daily returns / standard deviation × √365.
- **Win rate, profit factor, average hold time:** from round-trips in `fills_by_user`. For HL this needs `closedPnl`, which the public `trades` stream lacks. Pull authoritative fills hourly from `userFillsByTime` for tracked traders only.
- **Volume, trade count, asset mix, long/short skew:** straight from trades.

**Why precompute:**
- There are about 60 leaderboard JSON files (2 venues × 5 windows × 6 sorts, about 20 KB gzip each).
- They are served from the CDN, so origin traffic is about 60 files × 1 request per 30 s per upper-tier POP. That is a few thousand requests per hour, whatever the number of users.
- Writing them to R2 every 60 s would cost about $11.70/month in Class A operations (2.6 M writes × $4.50/M). Serving them from origin memory behind the CDN costs $0.

### 2.3 Which traders to track, and at what fidelity

| Tier | Who | What we store / poll | Rate-limit cost |
|---|---|---|---|
| **T0: copy leaders** (tens to hundreds) | any address with at least one active copier | sub-second fill detection from the **public trade streams** (no per-user subscription needed, so the 10-user/IP cap does not bind). Reconcile positions every 10–30 s (HL `clearinghouseState` weight 2; SoDEX `positions` weight 5). | HL: 100 leaders × 2 × 3/min = 600 weight/min (half an IP). Run it from the executor's IP, separate from analytics. |
| **T1: tracked** | SoDEX: every account seen trading in the last 30 d (low thousands). HL: top ≈5,000 from the leaderboard (by 30D PnL, volume, accountValue ≥ $10 k) plus any watch-listed address. | all trades (from the stream). Hourly catch-up of authoritative fills (HL `userFillsByTime`, weight 20 + 1 per 20 items; SoDEX `accounts/{addr}/trades?limit=1000`, weight 70). Hourly positions and equity. Daily HL `portfolio` / SoDEX `daily_stats`. | HL `clearinghouseState` hourly for 5 k traders = 167 weight/min (14 % of 1,200). `portfolio` daily = 100 k weight/day (6 % of 1.73 M/day). Fills catch-up for about 2 k daily-active traders hourly ≈ 1.2 M weight/day (use 2 egress IPs or every 2 h). |
| **T2: everyone else** | HL: remaining leaderboard rows and all other addresses seen in trades. SoDEX: dormant accounts of the 230.8 k. | trades from the stream anyway (marginal cost ≈ 0). HL leaderboard snapshot metrics (1 fetch of 39 MB per hour). SoDEX top-1000 pages (8 window/sort combinations × 20 pages hourly = 160 requests/h) plus `leaderboard/rank` on demand. **Lazy deep scan** when a user opens the address (cached 5–15 min). | negligible |

SoDEX account id → address resolution:
- Resolve once per id, cache forever, via `eth_call` `0x792713b8(uint256)` with round-trip `0x380e78af` (see Opentrade `server/src/sodex/chain.ts:498-500`).
- **Multicall3 is deployed on ValueChain** (`0xcA11…CA11` has code) and the RPC accepts JSON-RPC batches (both verified). Backfilling all about 230 k ids therefore takes minutes, not hours.
- The public RPC keeps only very recent state: `eth_call` at a block about 450 blocks (≈15 min) back fails with "missing trie node". So historical state (for example account-creation rate) needs an archive node or Blockscout. Blocks come about every 2.03 s (≈42.5 k per day).

---

## 3. Hosting

### 3.1 Frontend (SPA)

Traffic model (assumption): per monthly visitor, 2.5 sessions × 50 requests (hashed static assets plus precomputed JSON polls) and about 1 MB per session. That gives **100 k MV ≈ 12.5 M requests and 250 GB**, and **1 M MV ≈ 125 M requests and 2.5 TB**.

| Host | 100 k monthly visitors | 1 M monthly visitors | Basis |
|---|---|---|---|
| **Cloudflare Pages / Workers static assets** | **$0** (static requests "free and unlimited"; CDN bandwidth not billed). $5 if Workers Paid is used for edge functions. | **$0–5**. If the JSON goes through a Worker: $5 + 115 M × $0.30/M = **$39.50** | CF Pages Functions and Workers pricing pages |
| **S3 + CloudFront, pay-as-you-go** | **≈$3** (1 TB and 10 M requests are always free; 2.5 M × $0.01/10 k = $2.50) | **≈$245** (1.5 TB × $0.085 = $127.50; 115 M × $0.01/10 k = $115; EU requests $0.012/10 k) | CloudFront pay-as-you-go page |
| **S3 + CloudFront, flat-rate** | Pro **$15** (10 M requests, 50 TB; this traffic sits just over the request allowance) or Business $200 | Business **$200** (125 M requests) | CloudFront flat-rate plans |
| **Vercel Pro** | **≈$25** ($20 seat, 1 TB and 10 M edge requests included, +2.5 M × $2/M) | **≈$475** (+115 M × $2/M = $230; +1.5 TB × $0.15/GB = $225) | vercel.com/pricing; Hobby is non-commercial |

The Opentrade SPA (Vite) is static and deploys to Cloudflare as-is. Opentrade's CSP should be delivered as a header (`frame-ancestors 'none'`), as its DEPLOYMENT.md already requires.

### 3.2 API

| Option | Cost | Notes |
|---|---|---|
| Cloudflare Workers | $5/month includes 10 M requests and 30 M CPU-ms; then **$0.30/M requests** and $0.02/M CPU-ms | Good for SIWE nonce/verify, a thin relay and JSON edge caching |
| AWS Lambda + API Gateway HTTP API | $0.20/M (Lambda) + $1.00/M (HTTP API) + compute (≈$0.10/M at 256 MB × 30 ms on Arm) ≈ **$1.30/M**, plus $0.09/GB egress | 1 M requests and 400 k GB-s free per month |
| One container on a VPS (Fastify, as in Opentrade) | flat: CAX21 €10.49 | Serves precomputed JSON from memory at thousands of requests per second; the CDN absorbs most traffic |

Recommendation: **one Fastify service on the core box behind the Cloudflare CDN**. Add Workers only for edge concerns (SIWE nonce, the optional write relay).

### 3.3 WebSocket fan-out to browsers (live positions, tape, copy status)

Example load: 2,000 concurrent viewers × 1 message/s ≈ **5.18 B messages/month**.

| Option | Price basis | Example cost | ≈ $ per 1 M delivered messages |
|---|---|---|---|
| **API Gateway WebSocket** | $1.00/M messages (32 KB units) + $0.25/M connection-minutes | **≈$5,200/month** | **$1.00** |
| **Cloudflare Durable Objects** (hibernation API) | outgoing messages **free**; incoming billed at 20:1 × $0.15/M; duration $12.50/M GB-s (an always-busy 128 MB DO ≈ 324 k GB-s ≈ $4/month); 400 k GB-s included; $5 base | 4 sharded broadcast DOs ≈ **$16/month** | ≈$0.003 |
| **Self-hosted uWebSockets.js / Go hub on a VPS**, proxied by Cloudflare (WS supported on all plans, no extra charge) | Hetzner CAX21 €10.49 with 20 TB/month traffic in EU (€1/TB over) | ≈1.3 TB/month at 250 B/message, which is included, so **≈€10.49** | **≈$0.002** |

Recommendation: **a self-hosted hub on the core box**. Opentrade's `server/src/hub.ts` refcounted fan-out pattern ports directly. Move to Durable Objects only if you want to drop the origin from the live path. **Never use API Gateway WS for fan-out.**

### 3.4 SoDEX signed-write relay (CORS)

- Opentrade DEPLOYMENT.md:135 (Aug 2026) says the gateway does not serve permissive CORS for signed writes, so a relay would be needed.
- **Verified today (preflight only):** `OPTIONS https://mainnet-gw.sodex.dev/api/v1/perps/trade/orders` with a foreign `Origin` returns `204`, `access-control-allow-origin: *`, `access-control-allow-headers: …X-Api-Key,X-Api-Sign,X-Api-Nonce,X-Api-Chain` and `access-control-allow-methods: GET,POST,PUT,PATCH,DELETE,OPTIONS`. Public GETs also carry `ACAO: *`. The HL `/info` endpoint returns `access-control-allow-origin: *` as well.
- **Not verified:** whether a real signed POST response carries ACAO. That needs a signed request and therefore the owner's go.
- If it holds, the browser posts directly (lowest latency, no custody of traffic). Keep a **stateless relay** in reserve: a Cloudflare Worker at $0.30/M, or a route on the Tokyo executor box. Note the risk: the SoDEX weight limit is per IP, and relayed traffic from shared egress would pool users into one bucket.
- `sodex.com/auth/v2/*` (SoPoints) is still origin-allowlisted per Opentrade NOTES.md, so ValueDesk would need to be allowlisted by SoDEX.

### 3.5 User management (SIWE; no emails)

- **Flow:**
  1. `GET /auth/nonce`: the nonce lives in Valkey with a 5-minute TTL.
  2. The wallet signs an EIP-4361 message: domain, uri, chainId (286623 or 1), nonce, issuedAt, expirationTime.
  3. `POST /auth/verify`: viem `verifySiweMessage`. Include EIP-1271 for smart wallets, which needs an RPC call.
  4. The server sets an HttpOnly, Secure, SameSite=Lax session cookie (signed JWT/PASETO, 7–30 days) and keeps a small revocation table.
- **Data we store** (all keyed by address; a few MB for 100 k users):
  - `users(address pk, created_at, last_seen, prefs jsonb)`
  - `watchlists(user, venue, trader, label)`
  - `alerts(id, user, venue, trader, type[new_position|size_change|pnl_threshold|drawdown|liquidation_risk], params jsonb, channel, cooldown, last_fired_at)`
  - `notify_targets(user, telegram_chat_id, webpush_subscription jsonb)`
  - `copy_configs(id, user, leader_venue, leader, follower_venue, subaccount/vault, sizing_mode[fixed|proportional|multiplier], max_leverage, max_position_usd, allow_assets[], sl_pct, max_slippage_bps, status, contract_addr, updated_at)`
  - `copy_events`: an audit trail (leader fill → intent → order → result, with latencies). Put it in ClickHouse; it is append-only.
- **Where Postgres lives:**
  - **Bootstrap:** Postgres 16 on the core box, with WAL-G/pgBackRest to R2.
  - **Growth:** Neon Launch ($0.106/CU-hour, $0.35/GB-month; 0.25 CU always-on ≈ $19/month) or Supabase Pro ($25/month; includes $10 compute credit, 8 GB disk, 250 GB egress).
  - RDS only if AWS is unblocked and the executor is on AWS Tokyo.
  - The copy executor must **cache configs in memory** (LISTEN/NOTIFY or a 1–5 s poll) so that the user DB is never on the hot path.
- **Privacy (assumption, not legal advice):** wallet addresses and Telegram chat ids are pseudonymous personal data under GDPR (the operator is in the EU). Publish a privacy note and provide a self-service delete.

### 3.6 Notifications

- **Telegram Bot API:** free. Limits are about 30 messages/s total broadcast, 1 message/s per chat and 20 messages/min per group. Paid broadcast allows up to 1,000 messages/s at 0.1 Star per message above 30/s, but requires 100 k Stars and 100 k MAU. At MVP the free limits are fine; queue and shard alerts.
- **Web Push (VAPID):** no per-message fee. The browser vendors' push services deliver it; payloads of about 4 KB (assumption). It suits PWA installs.
- **Email:** none, by design.

---

## 4. AWS vs alternatives (honest comparison)

| Role | AWS (on-demand, verified from AWS public price JSON 2026-09-24) | Alternative | Ratio |
|---|---|---|---|
| Core box, about 8 GB | c7g.xlarge 4 vCPU/8 GB: **Frankfurt $120.38/month**, Tokyo $132.79; + gp3 + public IPv4 (~$3.65) | **Hetzner CAX31** 8 vCPU ARM/16 GB/160 GB **€20.99** (20 TB traffic) | ~6× |
| 64 GB analytics node | r7g.2xlarge 8 vCPU/64 GB ≈ **$377/month** Frankfurt (2 × r7g.xlarge $188.63) | **Hetzner AX42** (Ryzen 7 PRO 8700GE, 64 GB) **€97.30** + €49 setup (price after 15 Jun 2026) | ~3.5× |
| Tokyo copy executor | **t4g.small $15.77**, t4g.medium $31.54, c7g.large $66.43, c8g.large $73.04 (ap-northeast-1) | Hetzner has **no Tokyo**. Tokyo VPS e.g. Vultr 2 vCPU/4 GB ≈ $20–24 (documented-3p); Fargate ARM 1 vCPU/2 GB ≈ $29 us-east-1 (+Tokyo uplift) | AWS is competitive here |
| HL non-validator node | r7g.4xlarge 16 vCPU/128 GB Tokyo ≈ **$754/month** (4 × $0.2584/h) + 500 GB–1 TB SSD | Tokyo bare-metal providers (unverified, ≈$400–700) | — |
| Egress | $0.09/GB (US/EU), **$0.114/GB (Japan)** after 100 GB/month free | Hetzner 20 TB included in EU (Singapore: 0.5–8 TB, then €7.40/TB, documented-3p); **Cloudflare: not billed** | — |
| Object storage | S3 Standard ≈ $0.023/GB-month + egress | **R2 $0.015/GB-month, zero egress**; Hetzner Object Storage €6.49/month includes 1 TB storage and 1 TB egress | — |

**Constraints that decide this:**
- **EC2 RunInstances is blocked on account 568311961884 (since 2026-09-06).** The hard rule forbids test-instance churn. So:
  - (a) Do **not** plan any analytics on EC2.
  - (b) If AWS is used for the Tokyo executor after the block is lifted: one CloudFormation stack. The network stack stays up; compute stays at a fixed count (stop, never terminate, between sessions); deploy once and delete once.
  - (c) Whether Fargate or Lightsail is also affected by the block is unknown. Check account status in the console; do not probe by launching.
- **Latency:**
  - HL's API origin is in Tokyo. `api.hyperliquid.xyz` resolves to CloudFront (FRA POP here) and HL says "For lowest latency, run the node in Tokyo."
  - `mainnet-gw.sodex.dev` and `rpc.valuechain.xyz` sit behind Cloudflare (104.17.90/91.73; CF-RAY …-FRA), so the origin region is hidden.
  - From Frankfurt, the minimum TTFB was **≈290–300 ms for SoDEX REST**, about the same as HL (≈289 ms, Tokyo origin). That is consistent with an East-Asia origin. The latency agent should pin the exact region.
  - Only the executor needs to be near the venues. Indexing and analytics are latency-insensitive: the leaderboard refreshes every 30–60 s.
- **Where AWS is worth it:** a managed, audited environment for the money-adjacent executor, plus the owner's existing familiarity. **Where it is not:** everything that just crunches or serves public data.

---

## 5. Reference stacks

### 5.1 Bootstrap (< $100 per month): target ≈ $50–60

| Component | Choice | $/month |
|---|---|---|
| Frontend, CDN, DNS, TLS | Cloudflare Free + Workers static assets (or Pages) | 0 |
| Edge functions (SIWE nonce, optional write relay) | Cloudflare Workers Paid | 5 |
| Core box (EU) | **Hetzner CAX31** (8 vCPU ARM, 16 GB, 160 GB NVMe) running the SoDEX and HL ingesters, **ClickHouse** (single node), **Postgres 16**, **Valkey**, Fastify API, WS hub (uWS), precompute job. Behind the Cloudflare proxy. | ≈24.50 (€20.99) |
| Cold archive and backups | Cloudflare R2 (10 GB free; about 100 GB by month 12) | 0–1.50 |
| Copy executor (only when step 2 starts) | 1 persistent Tokyo VM: AWS t4g.small ($15.77) if EC2 is unblocked, else a Tokyo VPS (≈$20–24) | 16–24 |
| Notifications | Telegram Bot API, Web Push | 0 |
| Monitoring | Grafana Cloud free / Uptime Kuma on the box | 0 |
| Domain | — | ≈1 |
| **Total** | | **≈$47–56** (≈$31 before the executor exists) |

Limits: no HA. A box failure loses the live ingest gap, so HL history is refilled from `userFillsByTime` (only the 10 k most recent per user) and SoDEX history from the REST history endpoints. That is acceptable before real money flows.

### 5.2 Growth (≈ $500 per month): target ≈ $430–560

| Component | Choice | $/month |
|---|---|---|
| Cloudflare | Pro ($25) + Workers Paid ($5) + Load Balancing (≈$5) | 35 |
| Analytics DB | **2× Hetzner AX42** (ClickHouse ReplicatedMergeTree) + **3× CAX11** ClickHouse Keeper | ≈248 (€212.57; +€98 one-off setup) |
| API, WS and ingest | **2× CAX21** active-active. Ingest is duplicated on both, so a single failure causes no gaps (dedup on `tid` / (`symbol`,`t`)). | ≈24.50 |
| Users DB | Neon Launch (≈$19–39) or Supabase Pro ($25) | 25–40 |
| Tokyo executors | **2×** for HA (AWS c7g.large $66.43 each in one IaC stack, or Tokyo VPS ≈$24 each) | 48–133 |
| Extra egress IPs for HL/SoDEX polling budgets | 2× CAX11 (€5.99) | ≈14 |
| R2 (archive and backups, 0.5–1 TB) | $0.015/GB | 8–15 |
| Observability (metrics, logs, paging) | Grafana Cloud Pro / Better Stack | 20–50 |
| **Total** | | **≈$425–560** |

### 5.3 Scale: ≈ $2.5–4.5 k per month

| Component | Choice | $/month |
|---|---|---|
| Own HL data | **HL non-validator node in Tokyo** (16 vCPU / 128 GB / 500 GB+ SSD; `--write-fills --batch-by-block`). Full fills with `closedPnl`, fees and builder fees for **all** users, with no rate-limit dependence. | ≈750–900 (AWS r7g.4xlarge + SSD) or ≈400–700 bare metal |
| Own ValueChain RPC / archive | an archive or full node for historical state and event indexing (the public RPC is pruned to minutes) | ≈100–250 (assumption) |
| Analytics DB | 3× Hetzner AX102 (€257.30) replicated + Keeper, tiered to R2; **or** ClickHouse Cloud Scale 2×32 GiB (≈$1.7–2 k) | ≈920–2,000 |
| API and WS | 4× CAX31 + Cloudflare Business ($250) or Durable Objects for fan-out | ≈350 |
| Executors | Tokyo ×2 + second region near the SoDEX origin ×2 | ≈150–270 |
| Postgres HA | Neon Scale (2 CU ≈ $324) / RDS Multi-AZ | ≈300 |
| Observability, logs, backups | — | ≈200–400 |
| **Total** | | **≈$2.5–4.5 k** |

### 5.4 Triggers to move up a tier

**Bootstrap → Growth:**
- The first real copy-trading volume, or more than 25–50 active copiers: executor HA and no ingest gaps become mandatory.
- ClickHouse memory above 70 % or background merges lagging; disk above 60 %.
- p95 API above 200 ms at origin, or more than 5 k concurrent WS clients.
- HL `userFillsByTime` catch-up needing more than one IP of weight.

**Growth → Scale:**
- You need exact PnL, fees and builder fees for **all** HL traders rather than the top-N, or the public API limits bind (for example more than 20 k T1 traders at minute-level state).
- Adding a third or fourth venue, or storing order and book events.
- More than about 1.5 TB warm.
- An SLA commitment, or revenue above about $20 k/month so that infrastructure stays under 10–15 % of revenue.

---

## 6. Facts table

| # | Claim | Confidence | Source |
|---|---|---|---|
| 1 | SoDEX `getNextAccountId()` (`0xab00c0da`) on `0x0101…0101` = 230,773 → 230,774 between 10:14 and 10:26 UTC 2026-09-25 | verified | `eth_call` rpc.valuechain.xyz; selector in Opentrade NOTES.md:176 |
| 2 | Highest assigned account id 230,773 (`0x792713b8` returns an owner); 230,774+ returns the zero address | verified | `eth_call`; Opentrade `server/src/sodex/chain.ts:498` |
| 3 | SoDEX public `trade` WS payload carries `bi`/`si` (buyer/seller account ids); REST prints do not | verified | live WS capture; Opentrade `web/src/api.ts:210-216` |
| 4 | SoDEX 24 h volume perps $104.9 M (91 markets), spot $1.49 M (34 markets) | verified | `/api/v1/{perps,spot}/markets/tickers` |
| 5 | SoDEX 30-day average $141.7 M/day (range $44.9–602.8 M) | verified | `mainnet-data.sodex.dev/api/v1/dashboard/volume` |
| 6 | SoDEX trade rate 9.5–9.9/s (≈0.82–0.85 M/day by time; ≈1.04 M by notional) | verified (rate) / inferred (per day) | 6-min and 4-min WS samples |
| 7 | 85 % of sampled SoDEX prints involve account 1002 | verified | 4-min capture |
| 8 | SoDEX leaderboard `total` 134,605; pages capped at 1,000 rows; hourly `snapshot_ts` | verified | `/api/v1/leaderboard` pages 20/21 |
| 9 | SoDEX data API exposes per-account `pnl/daily_stats` and `pnl/overview` without a key | verified | account 52599 responses |
| 10 | SoDEX REST limit documented as 1,200 weight/min/IP; live header `x-ratelimit-limit: 6000` | documented + verified | sodex.com/documentation/…/api-rate-limits; response header |
| 11 | SoDEX WS: 10 connections/IP, 1,000 subscriptions/IP, **10 unique users/IP**, 2,000 messages/min | documented | SoDEX rate-limits doc |
| 12 | SoDEX gateway preflight returns `ACAO: *` and allows `X-Api-Key/Sign/Nonce/Chain` headers | verified (preflight only) | `OPTIONS …/api/v1/perps/trade/orders` |
| 13 | Multicall3 deployed on ValueChain; JSON-RPC batching works; public RPC state pruned to ≈15 min | verified | `eth_getCode`, batch call, `missing trie node` |
| 14 | ValueChain block time ≈2.03 s | verified | blocks 14,700,000 → 14,784,952 over 2 days |
| 15 | HL 24 h notional: main perps $7.19 B, HIP-3 $2.47 B (xyz $2.41 B), spot $0.19 B | verified | `/info` metaAndAssetCtxs (+dex), spotMetaAndAssetCtxs |
| 16 | HL trade rate 55.6–56.7/s main+xyz (≈4.8–4.9 M/day) | verified (rate) / inferred (per day) | WS capture |
| 17 | HL 150,304,852 trades in the 30 days to 2026-09-22 (5.01 M/day) | documented-3p | cryptostruct.com/exchanges/hyperliquid |
| 18 | HL public `trades` include `users:[buyer,seller]` and `hash`, `tid` | verified | WS capture |
| 19 | HL leaderboard snapshot 46,887 rows / 39.1 MB, uncompressed, refreshed ≈ hourly | verified (size) / inferred (cadence) | stats-data.hyperliquid.xyz/Mainnet/leaderboard |
| 20 | HL limits: 1,200 weight/min/IP; `clearinghouseState` weight 2, most others 20 + per-item; 10 WS connections, 1,000 subscriptions, **10 unique users**, 2,000 messages/min | documented | HL rate-limits doc |
| 21 | HL `userFills` ≤2,000 most recent; `userFillsByTime` ≤2,000 per call, only the 10,000 most recent available | documented | HL info-endpoint doc |
| 22 | HL non-validator node: 16 vCPU / 128 GB / 500 GB SSD; Tokyo recommended; ≈100 GB logs/day default | documented | github.com/hyperliquid-dex/node |
| 23 | HL S3 archives are requester-pays, uploaded ≈ monthly, no timeliness guarantee | documented | HL historical-data doc |
| 24 | Compressed size: HL 36.4 B/trade (Parquet ZSTD, with hash), 14.7 B per user-fill row; SoDEX 11.3 B/trade | verified (small sample) | DuckDB 1.5.2 on captured data |
| 25 | Hetzner (from 15 Jun 2026): CAX11 €5.99, CAX21 €10.49, CAX31 €20.99, CAX41 €40.99; AX42 €97.30 (+€49 setup); AX102 €257.30; AX162-1 €612.30 | documented | docs.hetzner.com/…/price-adjustment |
| 26 | AWS Tokyo on-demand: t4g.small $0.0216/h, t4g.medium $0.0432/h, c7g.large $0.091/h, r7g.xlarge $0.2584/h; Frankfurt c7g.xlarge $0.1649/h | verified | b0.p.awsstatic.com EC2 price JSON (Last-Modified 2026-09-24) |
| 27 | ClickHouse Cloud: 1 unit = 8 GiB/2 vCPU; Basic 24/7 $159.66 compute; storage $25.30/TB + backups at the same rate; Scale 2×8 GiB example $499.38 | documented | clickhouse.com/pricing; docs billing overview |
| 28 | Cloudflare Workers $5/month (10 M requests, 30 M CPU-ms), then $0.30/M; DO outgoing WS messages free, incoming 20:1, $12.50/M GB-s; R2 $0.015/GB-month, zero egress | documented | developers.cloudflare.com pricing pages |
| 29 | API Gateway WebSocket $1.00/M messages + $0.25/M connection-minutes | documented | aws.amazon.com/api-gateway/pricing |
| 30 | CloudFront always-free 1 TB + 10 M requests; $0.085/GB (US/EU), $0.114 (JP); flat-rate Pro $15 / Business $200 | documented | CloudFront pricing pages |
| 31 | Vercel Pro $20/seat, 1 TB + 10 M edge requests included, then $0.15/GB and $2/M | documented | vercel.com/pricing |
| 32 | Neon Launch $0.106/CU-hour, $0.35/GB-month; Supabase Pro $25/month | documented | neon.com/pricing; supabase.com/pricing |
| 33 | BigQuery $6.25/TiB on-demand (1 TiB/month free), $0.02/GB active storage | documented-3p | multiple 2026 summaries of cloud.google.com/bigquery/pricing |
| 34 | MotherDuck Business $250/org/month; Standard $2.40/h; storage $0.04/GB | documented | motherduck.com/product/pricing |
| 35 | Telegram bots: about 30 messages/s broadcast, 1/s per chat; paid broadcast at 0.1 Star per message | documented | core.telegram.org/bots/faq |
| 36 | From Frankfurt, SoDEX REST minimum TTFB ≈290–300 ms, HL ≈289 ms; both behind CDNs (Cloudflare / CloudFront) | verified | curl timing |

---

## 7. Open questions (and how to close them)

1. **Does a real signed POST to the SoDEX gateway return `ACAO: *`?** The preflight does. Close it with one small signed order from a browser on a test origin, with the owner's go. If yes, the write relay is optional.
2. **Where is the SoDEX gateway origin?** Cloudflare hides it. The latency agent owns this. Close it by timing from Tokyo, Singapore and Hong Kong vantage points on already-running boxes, not new instances.
3. **Which SoDEX limit is authoritative: 1,200 (docs) or 6,000 (live header)?** Budget for 1,200. Ask SoDEX about a partner or builder tier with higher limits and origin allowlisting (for `sodex.com/auth`).
4. **SoDEX account-channel cap (10 users/IP):** is it enforced per connection or per IP, and do builders get more? It does not block us, because public `trade` carries `bi`/`si`. It matters only for order-level (not fill-level) leader signals.
5. **Does the SoDEX data API (`mainnet-data.sodex.dev`) have unpublished rate limits?** No headers were seen. Crawl politely (≤2 requests/s) and ask SoDEX.
6. **HL coverage headroom:** main perps (178) + HIP-3 (≈160 with volume) + spot (330) is close to the 1,000-subscriptions-per-IP cap. With HIP-3 growth, plan 2 ingest IPs.
7. **HL trader-level PnL outside the top-N:** the leaderboard gives only window aggregates. Exact PnL for everyone needs the Scale-tier node or requester-pays S3 (`node_fills_by_block`, which costs S3 egress). Price the S3 route before using it.
8. **Is the AWS block limited to RunInstances?** Status of Fargate, Lightsail and App Runner is unknown. Check account/support status in the console; do not probe by launching.
9. **Real SoDEX daily-active trader count:** the leaderboard cap hides it. Measure over 24–48 h of ingest (distinct `bi`/`si`), or read it from ClickHouse once running.
10. **Hetzner AX42 price:** the docs table shows €97.30 after 15 Jun 2026, against €57.30 in April. Verify at order time, and check the Server Auction for cheaper, setup-free boxes.

---

## 8. Recommendations for ValueDesk

1. **Ingest from public trade streams, not per-user subscriptions.** SoDEX `trade` with `symbols:[all]` (2 connections) and HL `trades` per coin (2–3 connections) attribute every trade to a trader at almost zero cost. Resolve SoDEX ids to addresses once, through Multicall3 on ValueChain.
2. **Borrow the venues' own PnL series.** Use HL `portfolio` and the leaderboard, and SoDEX `pnl/daily_stats` and `overview`. Compute only what they do not give (drawdown, Sharpe, win rate, hold time, asset mix) from your own data. For HL win rate, pull `userFillsByTime` hourly for T1 traders only.
3. **Start on the Bootstrap stack:** one Hetzner CAX31 plus Cloudflare Free/Workers plus R2, at about $30/month before the executor. Put everything behind the CDN, serve Leaderboard and Explore as 30–60 s precomputed JSON, and fan out live data through a self-hosted WS hub (port Opentrade `hub.ts`).
4. **Use ClickHouse** (MergeTree + AggregatingMergeTree MVs) as the warm store. Keep raw NDJSON.zst hourly on R2 so that any metric can be recomputed or back-tested later with DuckDB.
5. **Place only the executor in Tokyo.** Make it one persistent, IaC-defined instance, and give it its own ingest subscription to the public trade streams. Do not relay leader signals through the EU analytics box. AWS Tokyo only if the EC2 block is lifted, following the hard rule: define once, fixed count, stop and never churn.
6. **Keep user data minimal:** SIWE sessions, watchlists, alerts, copy configs and notification targets. No emails. Postgres on the box, then Neon or Supabase at Growth. The executor caches configs in memory.
7. **Notifications:** Telegram bot and Web Push only (both free). Queue alerts to respect the Telegram limits.
8. **Do not use:** API Gateway WebSocket for fan-out ($1/M messages), BigQuery as the serving store (pay-per-scan), Vercel at 1 M visitors (about $475/month against about $0 on Cloudflare), or any per-test instance churn.
9. **Revisit at Growth:** ask SoDEX, as a prospective builder, for higher rate limits, origin allowlisting and confirmation of CORS for signed writes.

---

### Sources

- Opentrade: `server/src/sodex/chain.ts:44-63,498-500`, `server/src/sodex/ws.ts:1-10`, `server/src/sodex/rest.ts:165-190`, `server/src/routes/external.ts:32-54,286-360`, `server/src/routes/scan.ts:160-230`, `web/src/api.ts:197-216`, `NOTES.md:170-190`, `DEPLOYMENT.md:120-140`, `SECURITY-COMPARISON.md`.
- SoDEX docs: https://sodex.com/documentation/for-developers/developers/trading/api-rate-limits.md ; data API limits: https://sodex.com/documentation/for-developers/developers/data-api/authentication-and-limits.md
- Hyperliquid docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits ; https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint ; https://github.com/hyperliquid-dex/node ; https://hyperliquid.gitbook.io/hyperliquid-docs/historical-data
- HL statistics: https://cryptostruct.com/exchanges/hyperliquid ; https://www.datawallet.com/crypto/hyperliquid-statistics ; https://www.hokanews.com/2026/08/hyperliquid-hits-263419-active-perp.html ; https://coinlaw.io/hyperliquid-statistics/
- Pricing: https://clickhouse.com/pricing ; https://clickhouse.com/docs/cloud/manage/billing/overview ; https://developers.cloudflare.com/workers/platform/pricing/ ; https://developers.cloudflare.com/durable-objects/platform/pricing/ ; https://developers.cloudflare.com/r2/pricing/ ; https://developers.cloudflare.com/pages/functions/pricing/ ; https://developers.cloudflare.com/network/websockets/ ; https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ ; https://aws.amazon.com/api-gateway/pricing/ ; https://aws.amazon.com/cloudfront/pricing/ ; https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/ ; https://aws.amazon.com/lambda/pricing/ ; https://aws.amazon.com/fargate/pricing/ ; https://aws.amazon.com/s3/pricing/ ; https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/Asia%20Pacific%20(Tokyo)/Linux/index.json ; https://vercel.com/pricing ; https://neon.com/pricing ; https://supabase.com/pricing ; https://motherduck.com/product/pricing/ ; https://www.tigerdata.com/pricing ; https://cloud.google.com/bigquery/pricing ; https://eco.ovhcloud.com/en/rise/ ; https://core.telegram.org/bots/faq ; Hetzner traffic/Object Storage (third-party summaries): https://onedollarvps.com/pricing/hetzner-cloud-pricing , https://european-alternatives.eu/product/hetzner-object-storage ; Vultr (third-party): https://onedollarvps.com/pricing/vultr-pricing
