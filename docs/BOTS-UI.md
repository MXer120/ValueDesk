# Bots section: pages and data contract (branch feat/bots, local until the owner ships it)

Owner, 2026-11-07: users' bots run on the ValueDesk executor on Contabo (server 2, the official SoDEX route; the AWS
box and the fast door are test only). The market maker is R10 (rests up to 10 s at the touch, Binance-led), with the
market gate (`stillBps` 12 over `stillMs` 60 000) as a switch, plus the other configs. Bots live at the bottom of the
sidebar. Pages, switched in the top bar (BotsNavSeg, the switch Trade uses for Futures / Spot): Overview (any number of bots, the latency of the wallet's own bots p50/p95/p99 per region over 24 h), New bot, Bot detail
(full control), Explore (estimated cost on every market without running there), Savings (next fee tier, staking,
cheaper markets). Everything behind `BOTS_ON` (web) so other work can ship without it.

## Why these numbers (measured 2026-11-04 to 11-07)

- A small maker's cost is fee + what the fills lose. Per fill everyone small loses about the same: about 1.0 bp on
  fills taken by 23342, about +0.1 bp on fills taken by 1002. So the market's cost for a new small maker is set by
  who takes there, which the public trades show (both account ids).
- The replay (scratchpad bsim.py) fitted on 33 live rounds reads small makers' real cost within about 0.1 bp.
- Weekend ETH: 23342 almost absent, 1002 ~98 % of flow, small makers at about the fee.

## GET /api/vs/bots/markets (apps/server, public, cached 5 min)

Query: `window=24h|7d` (default 24h).

```ts
interface BotMarketsResponse {
  at: number;                    // ms, when computed
  window: '24h' | '7d';
  fee: { makerBps: number; builderBps: number };   // what our bot user pays by default (1.2 + 0.1)
  markets: BotMarket[];          // every SoDEX perp with trades in the window, sorted by estCostBps ascending
}
interface BotMarket {
  symbol: string;                // 'BTC-USD'
  base: string;                  // 'BTC'
  tick: number; tickBps: number; // tick size and tick / price in bp
  price: number;
  volumeUsdH: number;            // all prints, $ per hour over the window
  spreadBps: number;             // median quoted spread (bookTickers samples), else from prints
  volBpsH: number;               // volatility: sum |1 min return| per hour in bp (path), from klines or prints
  takers: { t1002: number; t23342: number; other: number };        // share of maker volume by who took, 0..1
  smallMakers: {                 // makers that are not the market's dominant maker (each under 10 % of maker volume)
    count: number; volumeUsdH: number; fills: number;
    markout30Bps: number;        // their realized 30 s markout (positive = earned), vs the mid 30 s later
    on1002Bps: number | null;    // the same, fills taken by 1002 only
    on23342Bps: number | null;
  };
  estCostBps: number;            // what a new R10 bot pays all-in: makerBps + builderBps - smallMakers.markout30Bps
  estCostLowBps: number; estCostHighBps: number;   // range: bootstrap or hour-to-hour spread of the same estimate
  gateCostBps: number | null;    // the same estimate over the hours a market gate (1 min path < 12 bp) would quote
  capacityUsdH: number;          // small makers' volume per hour: what is there to take
  confidence: 'high' | 'medium' | 'low';            // by small-maker fills in the window (>= 2000, >= 300, less)
  weekdayCostBps: number | null; weekendCostBps: number | null;  // the 7 d split (UTC Sat/Sun), null under 300 fills
  hourly: Array<{ h: number; costBps: number | null; volumeUsdH: number }>;  // 24 UTC hours, the 7 d profile
}
```

## GET /api/copy/v1/bots/latency (apps/executor, Bearer session)

Query: `hours=24` (1..48). Only the signed-in wallet's own figures: the writes of the SoDEX accounts its bots trade in
(owner 2026-11-07: users see their own bots, never everyone's). No session: 401. A wallet whose bots only practise has
no account there, so its buckets are empty. The executor keeps the region-wide log for operators; no route serves it.

```ts
interface BotLatencyResponse {
  at: number;
  bucketMs: number;              // 600 000 (10 min)
  regions: Array<{
    id: string;                  // 'tokyo'
    label: string;               // 'Tokyo · SoDEX'
    where: string;               // the executor's location (EXECUTOR_LOCATION)
    buckets: Array<{ t: number; n: number; p50: number | null; p95: number | null; p99: number | null }>;
    now: { p50: number | null; p95: number | null; p99: number | null; n: number };  // last 10 min
    kinds: { place: { p50: number | null; n: number }; cancel: { p50: number | null; n: number } };  // last hour
  }>;
}
```

Measured per signed write to SoDEX: send to answer (queue + wire, ms), orders and cancels. Kept per 10 min for 48 h
(survives a restart: stored in the executor's database).

## Web

- `BOTS_ON` = dev builds, or `VITE_BOTS=1`. Off: no sidebar section, `/bots/*` falls back as today.
- Sidebar bottom (above Settings): Bots (overview), New bot, Explore, Savings.
- Routes: `/bots` overview, `/bots/new`, `/bots/explore`, `/bots/savings`, `/bots/<id>` detail.
