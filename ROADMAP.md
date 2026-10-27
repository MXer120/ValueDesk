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
