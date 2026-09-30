# Leaderboard indexer

Builds the leaderboard's hundreds: for **each venue** (SoDEX, Hyperliquid), **each
window** (24h, 7d, 30d, 90d, YTD, all time) and **each side** (top, worst), the 100
traders by PnL. It builds each one twice: among traders with **more than one trade in
that window**, and without that filter.

Every trader on a board is indexed in full over the window they are ranked in: all
fills, plus closed positions on SoDEX. After that, the live trade streams keep them
current. Code: `apps/server/src/indexer/`.

## What counts

- **PnL** is the venue's own number for the window where the venue publishes one:
  - Hyperliquid: the hourly leaderboard file, every ranked account, for 1d, 7d, 30d and all time.
  - SoDEX: the data host's ranking for 24H, 7D, 30D and ALL_TIME. The top 1,000 by
    PnL and the top 1,000 by volume come as lists. Every other wallet needs one
    rank lookup each.
- **90d and YTD** are published by neither venue:
  - After 90 days of daily all-time PnL snapshots (and a snapshot on 1 January for
    YTD), they come from those snapshots, for every account.
  - Until then, they come from each candidate's portfolio chart.
- **A trade** is one execution: an account's fills in one market, on one side, in
  one block.
  - A taker order that sweeps three makers is one trade.
  - A resting order filled at three different times is three trades.
  - The public streams and the REST histories carry exactly these fields, so both
    count the same thing.
- **"Worst" on SoDEX** is real. The data host only serves its top 1,000, and
  `sort_order=asc` is that list reversed (every "loser" was +$11). The candidates
  are:
  - the volume list;
  - every account the SoDEX trade stream saw trading in the window, looked up
    most volume first.

## Venues

| Venue | PnL source | Finding every trader | Trade check / fills |
|---|---|---|---|
| SoDEX | data host lists + rank lookups | trade stream (`bi`/`si` account ids) | stream; `positions/history`; `/trades` drip |
| Hyperliquid | leaderboard file (all accounts) | leaderboard file + trade stream | stream; `userFillsByTime` |
| trade.xyz | realised PnL − fees of `xyz:*` fills (HL publishes no per-dex PnL) | HL stream prints on `xyz:*`; the largest xyz books the cohorts found | HL fills, mirrored under `tradexyz` by the store |
| Lighter | `pnlLeaderboard`, walked in full (~97k accounts, both ends) | the same walk; `trade/{market}` WS (bid / ask sub-account indices) | stream (indices mapped to wallets in `ext_index`); two newest trades per sub-account; trades paged |
| Arcus | each trader's `/v1/portfolio` (realised + open) | `trades` WS names maker and taker; top-100 lists seed it | `/v1/fills` |

- Lighter and Arcus 90d / YTD come from daily all-time snapshots, so those boards stay empty until the snapshots reach back that far. trade.xyz computes every window from fills.
- trade.xyz (checked 2026-09-29):
  - Hyperliquid's leaderboard file and `portfolio` cover every dex together.
  - `clearinghouseState` with `dex: "xyz"` gives the xyz margin book (value, open PnL) but no realised PnL.
  - `userFills` has no dex filter.
  - So xyz PnL is realised PnL from fills. It is "as of" the last REST read: at most 2 h old for 24h, 6 h for the longer windows. It exists only for traders whose fills reach back to the window start and are not cut by Hyperliquid's 10k-fill cap.
  - Board account values fall back to the cohorts' xyz book reads.
- Lighter's stream (verified 2026-09-29) limits messages per IP ("Too Many Websocket Messages", "Too Many Inflight Messages").
  - Subscribes go out one per 700 ms across all sockets. Each is confirmed (`subscribed/trade`) and re-sent if it is not.
  - The stream counts as up only once all ~220 active markets are confirmed.
- Researched and not integrated (2026-09-28): Aster (no per-trader data without the trader's key), Variational (terms forbid bots and commercial reuse, Cloudflare challenge, masked addresses), Katana (terms forbid scraping, per-trader data needs the wallet's own key), Extended (full public list, but its terms forbid "distributing" the service; pending a decision), CEXes (only OKX has an official lead-trader API, and commercial display needs its licence).

## Rules the audit (2026-09-28) added

- A top board holds only gains and a worst board only losses; a thin candidate list is not padded with the wrong sign.
- Net leaves trade.xyz out whenever Hyperliquid is selected: Hyperliquid's own figures already include its xyz dex.
- Arcus `closedPnl` includes the fee; it is stored gross (Hyperliquid's convention), so opening fills are not losing closes.
- Hyperliquid REST fills (aggregated per order and time) and stream prints have different ids; stream rows inside a REST-read range are dropped.
- A Hyperliquid master with no fills of its own is counted through its sub-accounts (the leaderboard adds them into its row).
- Trade checks on Lighter and Arcus read a full page: the two newest rows can be fills of one execution.

## Win rate (one definition: `apps/server/src/valuescan/winRate.ts`)

- **One close** is a run of consecutive position-reducing fills in one market and one direction.
  - The run ends at the next fill in that market that adds to a position (realises nothing), at one that reduces the other way, or at the UTC day boundary.
  - So a TWAP that closes one short in 135 slices is one close, not 135 losses. That was the "0% win rate on +$11.8M" row.
  - SoDEX publishes closed positions (`positions/history`); each row is one close.
- **A win** is a close whose realised PnL, summed over its fills, is positive. It is gross of fees (the venues' `closedPnl` convention). Break-even closes are left out of the denominator.
- **Exact or estimate.**
  - A win rate is exact when the held closes reach back to the window start. It is then shown from one close.
  - Otherwise it is an estimate from the closes held, shown only from `WIN_RATE_MIN_CLOSES` (10) closes.
  - The API sends `winRate`, `winRateExact` and `winRateCloses`, and for an estimate also `winRateFrom` (the oldest held close).
  - The web shows an estimate as "≈" with a tooltip.
- **Where it is used.** The same figures reach:
  - the boards;
  - the netted view (wins and closes summed; exact only when every venue is);
  - `trader_stats`, which the screener, the cohort wallets and Scan read;
  - the screener's own profile sample (`fillStats`, `closedStats`), exact only when the sample is the whole history;
  - Scan.
- After this definition shipped, the day aggregates were re-summed under it in the background (`meta.closes_def = 2`). The old rows served until each trader's re-sum landed.

## Stream continuity and restarts

- The streams write every fill of a tracked wallet.
  - Every 30 s, each held range (`coverage`) that reaches into the current socket connection has its `to_t` moved up to now.
  - `rest_at` is not moved: realised PnL and closes come only from REST reads.
- After a restart or a reconnect:
  - A range stops at the old connection. It stays "fresh" for 10 minutes.
  - After that, the next board pass re-reads only the gap (`[to_t, now]`) for the rows on the boards, visible windows first.
  - Every wallet with a held range is tracked before the streams open.
- The all-account activity counts (the "more than one trade" test) still use the tolerant span, where a gap under 2 minutes does not break it. Outages are listed in `status.gaps`.

## Rank change

- Each board's ranks are snapshotted every hour (`board_rank`, kept 26 h).
- `rankChange` is the rank about 24 hours earlier minus the rank now. Until a day of snapshots exists, it compares with the oldest snapshot that is at least an hour old.
- `index.rankSince` gives the time compared against.
- `rankChange` is null when the trader was not on that board then, and on merged multi-venue pages.

## Cohorts

- **Membership** stays all-time: PnL cohorts by all-time PnL, size cohorts by current equity.
- **The wallet table's PnL column** is for the page's range (`range=1d|7d|30d`), from the venues' window lists:
  - Hyperliquid: every member.
  - SoDEX and Lighter: only the listed and looked-up wallets.
  - Arcus: from portfolios.
  - A range PnL that is not known is null, never the all-time figure.
- **Sampled tail** (Lighter, rate 10%): stratified by current equity.
  - Wallets below $10K count only when they are in the fixed sample (`sampleHash < rate`); each stands for 10.
  - A tail wallet outside the sample contributes no positions, even if it was read while it was large.
  - A cohort's `covered` is capped at its exact `wallets`.
- **Lighter books** follow the Lighter stream once the wallet's sub-account indices are known. A wallet's first read learns them.

## Loop health

- Day aggregates are built by a resumable scan, 1,000 fills per step, instead of per-slice SQL. A market maker's 3-day slice used to hold the worker's event loop for 2.6–7.4 s.
- A dirty day of more than 20,000 fills is summed in the background.
- Daily all-time snapshots and activity pruning run in slices. The cohort plan and record yield every 30 ms.
- `status.loopLagMs.spikes` names what ran when a stall began. The build marks itself after every breath.

## Lanes

- `status.lanes.<lane>.byKind` gives the queue per task kind. On `sdata` the kinds are:
  - `list`: the published lists;
  - `av`: account values of board rows (prio 2,500);
  - `rank`: lookups of stream-seen wallets (1,500 per window);
  - `chart`: the 90d / ytd pool, twice a day. Its time survives restarts.
- A lane backs off an upstream that answers 5xx or "Request Timeout", or times out: 15 s, doubling up to 5 minutes, reset by the next success. Rate limits keep their own, longer pause.
- Guaranteed shares (`coh:`, `walk:`, `pf:`) are shares of the lane's spend, not of its task count.

## Names

No username is shown. Every API row has `label: null`, and no search matches a name (`apps/server/src/valuescan/labels.ts`). The stored column is kept.

## Logos

Coin and brand icons for Hyperliquid, trade.xyz, Lighter and Arcus come from `apps/web/tools/fetch-venue-logos.mjs` (Hyperliquid's icon set, TradingView crypto marks, and issuer logos for US stocks and ETFs), stored under `public/logos/venues/` with `src/logoManifestVenues.ts`. Re-run it when those venues list new markets.

## How a board fills

1. Candidates come best first (highest PnL for top, lowest for worst).
2. With the trade filter, each one needs more than one trade in the window. The
   answer comes from, in order:
   1. **the stream**, once it has run without a gap since the window started
      (`stream_since:<venue>` in `meta`). The streams publish both parties of every
      trade (Hyperliquid `users`, SoDEX `bi`/`si`), so this covers every account and
      costs no REST.
   2. **indexed fills or closes**: Hyperliquid `userFillsByTime`; SoDEX
      `positions/history`, where two closes, or a position opened and closed in the
      window, prove it.
   3. otherwise the wallet waits and the board is marked not complete.
3. Picks are fully indexed over the window. Boards are rebuilt every minute and
   written to the `boards` table. The API reads that table in one query.

In steady state (the indexer running continuously) the trade filter costs no REST
at all:
- the 24h boards after one day;
- the 7d boards after a week;
- the 30d boards after a month.

## Processes

| Setup | Writer | Readers |
|---|---|---|
| dev / single box | API process starts a **worker thread** (`indexer/host.ts`) | the API process |
| production | `npm run indexer` (one process, `indexer/main.ts`) | API processes with `VALUESCAN_INDEXER=0` |

- Both share one SQLite file in WAL mode: one writer, any number of readers.
- The file is `VALUESCAN_INDEX_DB` (default: next to the device key, outside the
  synced tree).
- Status: `GET /api/vs/index/status` (lanes, streams, last build). The standalone
  process also logs one status line per minute.
- Run exactly **one** indexer per database file.

## Budgets (per IP)

Each upstream budget has its own lane. A lane rests after each task so that its
average stays at its share.

| Env | Default | Upstream |
|---|---|---|
| `VALUESCAN_INDEX_HL_WEIGHT` | 500 weight/min | Hyperliquid `/info` (1,200/min per IP; the API thread has its own client) |
| `VALUESCAN_INDEX_SODEX_CLOSES` | 6 req/min | SoDEX `positions/history` |
| `VALUESCAN_INDEX_SODEX_TRADES` | off | SoDEX `/trades` backfill; set a rate (req/min) to enable. Off by default since an audit on 2026-09-28 saw even a 0.5/min drip hit 429 |
| `VALUESCAN_INDEX_SODEX_TRADES_DAYS` | 30 | how far `/trades` reaches back for a SoDEX board member |
| `VALUESCAN_INDEX_SODEX_DATA` | 60 req/min | SoDEX data host (lists, rank lookups, charts) |
| `VALUESCAN_INDEX_STREAMS` | on | `0` = REST only |
| `VALUESCAN_INDEX_LIGHTER` | 30 req/min | Lighter (60/min per IP; the API thread keeps 20, burst 8) |
| `VALUESCAN_INDEX_ARCUS` | 450 weight/min | Arcus (1,500/min per IP; the API thread keeps 300) |

- **SoDEX `/trades` is limited by Cloudflare, not by the gateway.** Verified
  2026-09-28: error 1015 on the fifth request in about 30 s, while the gateway's own
  `x-ratelimit-remaining` still showed 5,900 of 6,000. A 1015 blocks the whole IP,
  trading UI included.
  - The indexer therefore only drips `/trades`.
  - Both SoDEX lanes stand back while any cooldown runs, and pause for 15–30 minutes
    after a 429.
  - Do not raise `VALUESCAN_INDEX_SODEX_TRADES` on an IP that also serves traders.
- **Hyperliquid serves only the 10,000 most recent fills per address.** A window
  that reaches past them is held from the oldest reachable fill and marked capped;
  its trade count reads as "at least".

## Cold start

A new database fills in this order:
1. the "any" boards (minutes);
2. the Hyperliquid trade-filtered boards (about 60 weight per check, so an hour or
   two at the default budget);
3. SoDEX boards as closes and the stream accumulate.

Until a board is complete, the API returns what is known, with `index.complete:
false` and the number of wallets waiting, and the page says so.

## Storage

The database grows as follows:
- **Fills:** one row per fill of each indexed trader. Hyperliquid is at most 10k per
  address; SoDEX at most 40k per engine.
- **Activity:** hourly rows for 36 days, daily rows for 400 days.
- **Daily all-time PnL:** about 47k Hyperliquid rows per day.

Histories of traders no board has wanted for 14 days are dropped.
