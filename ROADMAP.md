# ValueDesk: Roadmap

An on-chain address tracking and analytics platform on **ValueChain / SoDEX**, with opt-in copy trading.

## The two big steps

### Step 1: Track & analyze
Index and analyze on-chain trader addresses on **SoDEX** and **Hyperliquid** (more venues later), to find the ones with high win rates and high PnL.
Pages: **Explore**, **Leaderboard**, **Scan** (address detail), **Trade**, **Portfolio**, and the Cmd+K search.

### Step 2: Copy trading (opt-in) - live since 2026-10-23
A user picks an address and switches on copy trading themselves. The actual trades are **executed on SoDEX**, in the user's own SoDEX account, with **ValueDesk's builder code** attached (the copy fee ladder). The builder code is how ValueDesk earns. Three modes - this browser, the hosted executor in Tokyo, a self-hosted copier - run one engine: see **docs/COPY-TRADING.md**.

- **We never move funds.** SoDEX handles all funds, margin and settlement.
- The **copy trading contract** (a public on-chain record of who copies whom) is written and tested but not deployed; the live record is the follower-signed instructions each executor keeps.

> **Hard rule:** nothing is deployed on-chain (mainnet or testnet) without an explicit go from the owner.
> Contracts are written, tested and audited locally only.

## Planned

### Cost-basis bands (support / resistance by entry price) - owner, 2026-10-29
Like Glassnode's realized-price bands for BTC supply ("each line marks the price below which another 1% of supply
was bought"), but for **open perp positions**: per coin, the open interest by entry price, a band at each 1% of it,
shown over time against the price. Longs entered below the price and shorts entered above it are in profit
(support); longs above and shorts below are under water, and their break-even exits sit at their entry (resistance).
- **Now, every venue:** from the books the indexer already keeps (each position's size and entry price).
- **History, Hyperliquid and trade.xyz:** rebuilt from Hyperliquid's fills archive (S3, from 2025-07-27): every fill
  carries the position before it, so each wallet's size and average entry can be replayed hour by hour. Exact for
  positions opened inside the archive; a position opened before 2025-07-27 and not traded since has no known entry
  until it is touched (its current entry, where it is still open, fills that in).
- **History, SoDEX / Lighter / Arcus:** from the day it is built, unless their per-wallet trade histories reach back.
- Needs: one more archive replay on server 2 that keeps the hourly history (the first one kept 35 days), the
  temporary S3 read policy again, and storage per coin and hour as bands (not per position).
- Not planned: BTC's own on-chain (UTXO) version - that needs a Bitcoin node and UTXO index, or Glassnode's data.

## Where things are

| Area | Location |
|---|---|
| Frontend (Valuetrade base + new pages) | `apps/web` |
| Backend (Valuetrade server + `/api/vs/*` SoDEX/Hyperliquid trader data) | `apps/server` |
| SoDEX signing library (browser-safe) | `packages/sodex-core` |
| Copy engine (planner, feeds, runtime, signed API) | `packages/copy-engine` |
| Copy executor (hosted + self-hosted) | `apps/executor` |
| Algo orders (TWAP, VWAP, POV, iceberg, chase, scale, DCA, swarm, conditional, trailing): engine, browser runner, ticket, Algos tab, executor routes | `packages/copy-engine/src/algo`, `apps/web/src/algo`, `apps/web/src/components/algo` - see **docs/ALGO-ORDERS.md** |
| Copy trading contract (Foundry, not deployed) | `contracts/` |
| Contract spec & integration | `docs/contracts/` |
| Research | `docs/research/` (07 and 08 correct 01 and 03) |
